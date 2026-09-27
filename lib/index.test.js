/**
 * dsh-knj-workflow WorkflowBridge.startTask 测试（node:test）
 *
 * 背景缺陷：专用 parent 会话经 agents.create() 创建时没挂 agent preset，
 * 导致 workflow subagent（composeFrom 继承 parent 的组合）看不到 preset 层的
 * skill 工具与 catalog（~/.dsh/skills 等用户级/项目级 skills 全部缺失），
 * 连 write/bash 等 preset 层工具都没有。
 *
 * 运行：node --test lib/index.test.js（需能 resolve @deepseek-ai/schemastery，
 * 建议在已安装副本目录 ~/.dsh/profiles/web/node_modules/dsh-knj-workflow 下跑）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowBridge, registerRoutes, RunAlreadyActiveError, createKnjWorkflowSchedulerService } from './index.js';
import { formatInputDescription, INLINE_MAX, HEAD_MAX } from './requirement.js';
import { UploadStore } from './uploads.js';
import { assertInsideDir } from './attachments.js';

/** 最小 workflow 快照：start → task → end。 */
const WF = {
  id: 'wf1', name: 'WF',
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'n1', type: 'task', title: '做一件事', body: { prompt: '干活' } },
    { id: 'end', type: 'end' },
  ],
  edges: [
    { from: 'start', to: 'n1' },
    { from: 'n1', to: 'end' },
  ],
};

/** 声明了必填文件入参 doc 的工作流（服务侧必填校验用）。 */
const WF_FILE = { ...WF, id: 'wf-file', name: 'WF with file input', inputs: [{ name: 'doc', label: '需求文档', required: true, type: 'file' }] };

function makeTask() {
  return { id: 'task-x', title: 'T', workflowId: 'wf1', cwd: 'D:/w', workflowSnapshot: WF };
}

/** 默认的 agentPresets mock：resolve(undefined) 回落 'standard'，mount 记录调用。 */
function defaultPresetService(recorded) {
  return {
    async resolve(id) { return { id: id ?? 'standard' }; },
    async mount(agentCtx, id) { recorded.mountCalls.push([agentCtx?.tag, id]); },
  };
}

/** 构造 mock 环境：agents 服务（create/currentInitiator）、agentPresets 服务、workflowEngine。
 *  live='seed'（默认）：存在可继承的 seed 会话；live='none'：宿主无任何活跃会话
 *  （刚启动 dsh web 直接在插件面板建任务的场景：HTTP 链路无 initiator、roots 为空）。 */
function makeEnv({ seedPreset = 'standard', presetService = 'default', live = 'seed' } = {}) {
  const recorded = { createOpts: null, mountCalls: [], engineStartOpts: null, runDisposeCalls: 0 };
  const presetSvc = presetService === 'default'
    ? defaultPresetService(recorded)
    : presetService === 'none' ? undefined : presetService;
  const engine = {
    start(opts) {
      recorded.engineStartOpts = opts;
      return {
        id: 'run-1',
        cancel() {},
        dispose() { recorded.runDisposeCalls += 1; },
        result: Promise.resolve({ stopReason: 'completed', value: { results: {} } }),
      };
    },
  };
  const parentAgent = {
    id: 'parent-1',
    scope: { ctx: { get: (n) => (n === 'workflowEngine' ? engine : undefined) } },
  };
  const seed = {
    session: { header: { cwd: 'D:/w', ...(seedPreset ? { agentPreset: seedPreset } : {}) } },
    options: {},
  };
  const agents = {
    currentInitiator: () => (live === 'none' ? undefined : seed),
    roots: () => (live === 'none' ? [] : [seed]),
    async create(opts) {
      recorded.createOpts = opts;
      return { agent: parentAgent, dispose: async () => {} };
    },
  };
  const ctx = {
    on() {}, off() {},
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'agents') return agents;
      if (name === 'agentPresets') return presetSvc;
      return undefined;
    },
  };
  const store = {
    tasksDir: '.tasks',
    getWorkflow: async (id) => (id === 'wf-file' ? WF_FILE : WF),
    listWorkflows: async () => [WF_FILE, WF],
    saveTask: async (t) => { recorded.savedTasks = recorded.savedTasks || []; recorded.savedTasks.push(t); },
    mutateTask: async () => {},
    saveResults: async () => {},
    writeStage: async () => {},
  };
  return { ctx, store, recorded, agents };
}

test('startTask: 无快照的任务（调度器路径）→ 把触发时解析的定义回写为 workflowSnapshot（UI 依赖它渲染图/审批卡）', async () => {
  const { ctx, store, recorded } = makeEnv();
  const bridge = new WorkflowBridge(ctx, store, 'script');
  const task = makeTask();
  delete task.workflowSnapshot; // 模拟调度器创建：不预存快照（触发时用最新定义）
  await bridge.startTask(task, {});

  // 运行配置用触发时定义（既有语义不变）
  assert.equal(recorded.engineStartOpts?.args?.config?.id, WF.id, '运行应使用 getWorkflow 解析的定义');
  // 回写：后续 saveTask 落盘的任务必须带快照，否则任务详情无流程图、人工节点审批卡直接白屏
  const saved = (recorded.savedTasks || []).filter((t) => !t.workflowSnapshot);
  assert.equal(saved.length, 0, '落盘的任务不应缺 workflowSnapshot');
  const withSnap = (recorded.savedTasks || []).find((t) => t.workflowSnapshot);
  assert.ok(withSnap, 'startTask 解析定义后应回写 workflowSnapshot');
  assert.equal(withSnap.workflowSnapshot.id, WF.id, '快照 = 触发时解析的定义');
});

// ---------------------------------------------------------------------------
// 超阈值需求注入：Host 预计算 inputDescription（脚本沙箱内无法 import）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 超阈值需求落盘：单点 owner = startTask（所有创建路径最终都经过它）
// 背景（用户提问发现的漏洞）：落盘原先写在 POST /tasks 路由里，而调度器路径
// createAndStartScheduledTask 直接构造 task 后 saveTask → startTask，**不走路由**，
// 于是调度器创建的长需求不落盘、注入退化成「完整需求未落盘」——长需求对节点等于丢失。
// ---------------------------------------------------------------------------

/** 带真实 tasksDir 的启动环境（store 只需 tasksDir + saveTask；引擎桩记录 args）。 */
function makeStartEnv(tasksDir) {
  const recorded = { engineStartOpts: null, savedTasks: [] };
  const engine = {
    start(opts) {
      recorded.engineStartOpts = opts;
      return { id: 'run-1', cancel() {}, dispose() {}, result: Promise.resolve({ stopReason: 'completed', value: { results: {} } }) };
    },
  };
  const parentAgent = { id: 'parent-1', scope: { ctx: { get: (n) => (n === 'workflowEngine' ? engine : undefined) } } };
  const seed = { session: { header: { cwd: 'D:/w' } }, options: {} };
  const agents = {
    currentInitiator: () => seed, roots: () => [seed],
    async create() { return { agent: parentAgent, dispose: async () => {} }; },
  };
  const ctx = {
    on() {}, off() {},
    logger: { info() {}, warn() {} },
    get: (n) => (n === 'agents' ? agents : undefined),
  };
  const store = {
    tasksDir,
    getWorkflow: async (id) => (id === 'wf-file' ? WF_FILE : WF),
    listWorkflows: async () => [WF_FILE, WF],
    saveTask: async (t) => { recorded.savedTasks.push(t); },
    mutateTask: async () => {},
    saveResults: async () => {},
    writeStage: async () => {},
  };
  return { ctx, store, recorded };
}

test('startTask：超阈值需求在**启动前**落盘 <taskDir>/requirement.md 并注入文件指针', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-start-spill-'));
  try {
    const { ctx, store, recorded } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script');
    const task = { id: 'task-big', title: 'T', workflowId: 'wf1', cwd: 'D:/w', description: '需'.repeat(INLINE_MAX + 500) };

    await bridge.startTask(task, {});

    const file = join(root, 'tasks', 'task-big', 'requirement.md');
    assert.ok(existsSync(file), '启动前必须把全文落盘（否则节点只能拿到头部摘录）');
    assert.equal(readFileSync(file, 'utf8'), task.description, '落盘必须是全文');
    assert.equal(task.descriptionFile, file, '任务上应记录需求文件路径');

    const injected = recorded.engineStartOpts?.args?.task?.inputDescription || '';
    assert.ok(injected.includes(file), '注入文本必须指向落盘文件');
    assert.ok(injected.startsWith('需'.repeat(HEAD_MAX)), '应以头部摘录开头');
    assert.ok(!/未落盘/.test(injected), '不得出现「未落盘」降级提示');

    // 幂等：resume/rerun 会再次经过同一个 spill（用新 bridge 实例模拟新一轮启动，
    // 同一 bridge 二次 startTask 会抛 RunAlreadyActiveError）
    const second = new WorkflowBridge(ctx, store, 'script');
    await second.startTask(task, {});
    assert.equal(task.descriptionFile, file, '重复启动不得改变文件路径');
    assert.equal(readFileSync(file, 'utf8'), task.description, '重复启动不得改写内容');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 路径型文件入参（OpenSpec: add-scheduled-path-inputs）
// 调度任务不在表单里选文件，而是**引用工作区路径**；文件在触发时读取，相对路径按任务 cwd 解析。
// ---------------------------------------------------------------------------

test('listWorkflows：返回声明的任务输入参数（调度器据此渲染文件路径字段）', async () => {
  const { ctx, store } = makeStartEnv('.tasks');
  const bridge = new WorkflowBridge(ctx, store, 'script');
  const service = createKnjWorkflowSchedulerService(store, bridge);

  const list = await service.listWorkflows();
  const withFile = list.find((w) => w.id === 'wf-file');
  const plain = list.find((w) => w.id === 'wf1');
  assert.deepEqual(withFile?.inputs, [{ name: 'doc', label: '需求文档', required: true, type: 'file' }],
    '应暴露声明（name/label/required/type），供调度器按类型渲染字段');
  assert.deepEqual(plain?.inputs, [], '没有声明的返回空数组（形状稳定）');
});

test('createAndStartScheduledTask：pathInputs 并入 inputs，相对路径启动前解析成绝对路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-path-in-'));
  const ws = join(root, 'ws');
  try {
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, '今天的需求.md'), '# 内容', 'utf8');
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store, recorded } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    const service = createKnjWorkflowSchedulerService(store, bridge);

    const launched = await service.createAndStartScheduledTask({
      workflowId: 'wf-file', title: '定时任务', cwd: ws, pathInputs: { doc: '今天的需求.md' },
    });

    const dest = join(ws, '今天的需求.md');
    assert.equal(recorded.engineStartOpts?.args?.inputs?.doc, dest, '相对路径必须按 cwd 解析成绝对路径后交给节点');
    const saved = recorded.savedTasks.find((t) => t.id === launched.taskId && t.inputs);
    assert.equal(saved?.inputs?.doc, dest, '落盘的 inputs 也应是绝对路径');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createAndStartScheduledTask：必填文件入参由「路径」满足时不得报缺失', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-path-in2-'));
  const ws = join(root, 'ws');
  try {
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, 'doc.md'), 'x', 'utf8');
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    const service = createKnjWorkflowSchedulerService(store, bridge);

    await assert.doesNotReject(() => service.createAndStartScheduledTask({
      workflowId: 'wf-file', title: '定时任务', cwd: ws, pathInputs: { doc: 'doc.md' },
    }), '给了路径就不该再要求上传');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startTask：文件路径不存在 → 拒绝启动（报出参数名与路径），且不创建任何 run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-path-in3-'));
  const ws = join(root, 'ws');
  try {
    await mkdir(ws, { recursive: true });
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store, recorded } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    const service = createKnjWorkflowSchedulerService(store, bridge);

    await assert.rejects(() => service.createAndStartScheduledTask({
      workflowId: 'wf-file', title: '定时任务', cwd: ws, pathInputs: { doc: '还不存在的文件.md' },
    }), (e) => e.message.includes('doc') && e.message.includes('还不存在的文件.md'),
    '错误必须指出是哪个参数、哪个路径');

    assert.equal(recorded.engineStartOpts, null, '校验失败不得启动 run（不能带着无效入参跑）');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startTask：绝对路径原样使用并照常启动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-path-in4-'));
  const ws = join(root, 'ws');
  try {
    await mkdir(ws, { recursive: true });
    const abs = join(ws, 'abs.md');
    await writeFile(abs, 'x', 'utf8');
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store, recorded } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    const service = createKnjWorkflowSchedulerService(store, bridge);

    await service.createAndStartScheduledTask({ workflowId: 'wf-file', title: 'T', cwd: ws, pathInputs: { doc: abs } });
    assert.equal(recorded.engineStartOpts?.args?.inputs?.doc, abs, '绝对路径原样传递');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createAndStartScheduledTask（调度器路径）：超阈值需求同样落盘，节点不再丢长需求', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-sched-spill-'));
  try {
    const { ctx, store, recorded } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script');
    const service = createKnjWorkflowSchedulerService(store, bridge);

    const launched = await service.createAndStartScheduledTask({
      workflowId: 'wf1', title: '定时任务', cwd: 'D:/w', description: '需'.repeat(INLINE_MAX + 500),
    });

    const file = join(root, 'tasks', launched.taskId, 'requirement.md');
    assert.ok(existsSync(file), '调度器创建的长需求必须落盘（它不走 HTTP 路由，落盘只能由 startTask 保证）');
    const injected = recorded.engineStartOpts?.args?.task?.inputDescription || '';
    assert.ok(injected.includes(file), '调度器任务的注入文本必须指向落盘文件');
    assert.ok(!/未落盘/.test(injected), '不得退化为「完整需求未落盘」——那样长需求对节点等于丢失');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 文件入参：startTask 启动前把暂存文件物化到工作区（OpenSpec: add-knj-task-file-inputs）
// ---------------------------------------------------------------------------

test('startTask：把暂存上传物化到 <cwd>/.knj-inputs/<taskId>/，并把绝对路径写进 inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-file-input-'));
  const ws = join(root, 'ws');
  try {
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store, recorded } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);

    const staged = await uploads.stage({ name: '需求文档.md', dataBase64: Buffer.from('# 文档内容', 'utf8').toString('base64') });
    const task = {
      id: 'task-doc', title: 'T', workflowId: 'wf1', cwd: ws,
      pendingFileInputs: { doc: { uploadId: staged.uploadId, name: staged.name } },
    };

    await bridge.startTask(task, {});

    const dest = join(ws, '.knj-inputs', 'task-doc', '需求文档.md');
    assert.ok(existsSync(dest), '文件必须落到工作区内（节点与侧栏都在这个边界里工作）');
    assert.equal(readFileSync(dest, 'utf8'), '# 文档内容', '内容必须完整');
    assert.equal(task.inputs.doc, dest, 'inputs[param] 必须是绝对路径');
    assert.equal(task.pendingFileInputs, undefined, '物化后应清掉待物化记录');
    assert.ok(existsSync(join(ws, '.knj-inputs', '.gitignore')), '应写自忽略 .gitignore');
    assert.equal(readFileSync(join(ws, '.knj-inputs', '.gitignore'), 'utf8').trim(), '*');
    assert.equal(await uploads.resolve(staged.uploadId), null, '暂存应在物化后被清理');

    // 节点侧：${inputs.doc} 能解析到该路径（args.inputs 就是 orchestrator 的 inputs 上下文）
    assert.equal(recorded.engineStartOpts?.args?.inputs?.doc, dest, '节点必须能从 args.inputs 拿到路径');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startTask：暂存失效（被清理/未上传）→ 拒绝启动并给可操作错误，不让入参指向空', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-file-input2-'));
  try {
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    const task = {
      id: 'task-gone', title: 'T', workflowId: 'wf1', cwd: join(root, 'ws'),
      pendingFileInputs: { doc: { uploadId: 'up-zzzz-12345678', name: 'x.md' } },
    };
    await assert.rejects(() => bridge.startTask(task, {}), (e) => /doc/.test(e.message) && /重新选择文件/.test(e.message));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startTask：无 cwd 时文件入参给出可操作错误（不允许悄悄跳过）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-file-input3-'));
  try {
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    const staged = await uploads.stage({ name: 'a.md', dataBase64: Buffer.from('x', 'utf8').toString('base64') });
    const task = { id: 'task-nocwd', title: 'T', workflowId: 'wf1', pendingFileInputs: { doc: { uploadId: staged.uploadId } } };
    await assert.rejects(() => bridge.startTask(task, {}), (e) => /工作目录/.test(e.message));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startTask：两个参数传同名文件 → 第二个加参数名前缀，互不覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-file-input4-'));
  const ws = join(root, 'ws');
  try {
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    const a = await uploads.stage({ name: 'same.md', dataBase64: Buffer.from('AAA', 'utf8').toString('base64') });
    const b = await uploads.stage({ name: 'same.md', dataBase64: Buffer.from('BBB', 'utf8').toString('base64') });
    const task = {
      id: 'task-dup', title: 'T', workflowId: 'wf1', cwd: ws,
      pendingFileInputs: { first: { uploadId: a.uploadId }, second: { uploadId: b.uploadId } },
    };

    await bridge.startTask(task, {});

    assert.equal(readFileSync(task.inputs.first, 'utf8'), 'AAA');
    assert.equal(readFileSync(task.inputs.second, 'utf8'), 'BBB');
    assert.notEqual(task.inputs.first, task.inputs.second, '两份文件必须落在不同路径');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createAndStartScheduledTask：必填文件入参缺失 → 拒绝启动（服务侧校验，与路由一致）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-file-input6-'));
  try {
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    const service = createKnjWorkflowSchedulerService(store, bridge);
    await assert.rejects(
      () => service.createAndStartScheduledTask({ workflowId: 'wf-file', title: '定时任务', cwd: join(root, 'ws') }),
      (e) => /doc/.test(e.message) && /缺少必填文件入参/.test(e.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createAndStartScheduledTask（调度器路径）：文件入参同样在启动前物化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-file-input5-'));
  const ws = join(root, 'ws');
  try {
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store, recorded } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    const service = createKnjWorkflowSchedulerService(store, bridge);

    // 调度器路径不经过 HTTP 路由：它把 fileInputs 直接放进任务对象，物化只能由 startTask 保证
    const staged = await uploads.stage({ name: 'sched.md', dataBase64: Buffer.from('S', 'utf8').toString('base64') });
    const launched = await service.createAndStartScheduledTask({
      workflowId: 'wf1', title: '定时任务', cwd: ws,
      fileInputs: { doc: { uploadId: staged.uploadId, name: staged.name } },
    });

    const dest = join(ws, '.knj-inputs', launched.taskId, 'sched.md');
    assert.ok(existsSync(dest), '调度器路径创建的文件入参也必须物化（它不走路由）');
    assert.equal(recorded.engineStartOpts?.args?.inputs?.doc, dest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 内置通用附件（无需在 workflow 里声明）：用户直接选文件 → 路径灌进 inputs.附件
// 为什么不再要求声明：实机上 7 个 workflow 全是零 inputs 声明，于是「选文件」入口
// 根本不存在——用户在「新建任务」里找不到任何地方选文件。附件是通用能力，不该让人
// 先回编辑器声明一遍才看得见，所以它由 Host 兜底提供。
// ---------------------------------------------------------------------------

test('startTask：内置附件物化到工作区，inputs.附件 = 换行拼接的绝对路径（同名自动加序号，互不覆盖）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-attach-'));
  const ws = join(root, 'ws');
  try {
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store, recorded } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);

    const a = await uploads.stage({ name: '需求说明.docx', dataBase64: Buffer.from('AAA', 'utf8').toString('base64') });
    const b = await uploads.stage({ name: '接口.md', dataBase64: Buffer.from('BBB', 'utf8').toString('base64') });
    const c = await uploads.stage({ name: '接口.md', dataBase64: Buffer.from('CCC', 'utf8').toString('base64') });
    const task = {
      id: 'task-att', title: 'T', workflowId: 'wf1', cwd: ws,
      pendingAttachments: [
        { uploadId: a.uploadId, name: a.name },
        { uploadId: b.uploadId, name: b.name },
        { uploadId: c.uploadId, name: c.name },
      ],
    };

    await bridge.startTask(task, {});

    const dir = join(ws, '.knj-inputs', 'task-att');
    const p1 = join(dir, '需求说明.docx');
    const p2 = join(dir, '接口.md');
    const p3 = join(dir, '2-接口.md');
    assert.ok(existsSync(p1) && existsSync(p2) && existsSync(p3), '三个文件都必须落到工作区（同名不能互相覆盖）');
    assert.equal(readFileSync(p2, 'utf8'), 'BBB', '先上传的同名文件保留原名与原内容');
    assert.equal(readFileSync(p3, 'utf8'), 'CCC', '后上传的同名文件加序号前缀，内容不丢');
    assert.equal(readFileSync(p1, 'utf8'), 'AAA');

    // 节点侧契约：固定键「附件」，换行拼接的绝对路径（与上游 ${inputs.附件} 对应）
    assert.equal(task.inputs['附件'], [p1, p2, p3].join('\n'), 'inputs.附件 必须是换行拼接的绝对路径串');
    assert.equal(recorded.engineStartOpts?.args?.inputs?.['附件'], task.inputs['附件'], '节点必须能从 args.inputs 拿到附件路径');
    assert.equal(task.pendingAttachments, undefined, '物化后应清掉待物化记录');
    assert.equal(await uploads.resolve(a.uploadId), null, '暂存应在物化后被清理');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startTask：附件暂存失效（被清理/未上传）→ 拒绝启动并报出文件名，不悄悄少文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-attach2-'));
  try {
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store, recorded } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    const task = {
      id: 'task-att-gone', title: 'T', workflowId: 'wf1', cwd: join(root, 'ws'),
      pendingAttachments: [{ uploadId: 'up-zzzz-12345678', name: '丢失的附件.md' }],
    };

    await assert.rejects(
      () => bridge.startTask(task, {}),
      (e) => /丢失的附件\.md/.test(e.message) && /重新选择文件/.test(e.message),
    );
    assert.equal(recorded.engineStartOpts, null, '不得带着缺失附件启动 run');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startTask：没有附件时不得凭空造出 inputs.附件（否则节点拿到空串当路径用）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-attach3-'));
  try {
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store, recorded } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    // 空数组也要走这条路：表单会无条件带上 attachments 字段，不能因为「键存在」就写出空串
    const task = { id: 'task-noatt', title: 'T', workflowId: 'wf1', cwd: join(root, 'ws'), pendingAttachments: [] };
    await bridge.startTask(task, {});

    const inputs = recorded.engineStartOpts?.args?.inputs || {};
    assert.equal(Object.prototype.hasOwnProperty.call(inputs, '附件'), false, '无附件时不应存在 inputs.附件 键');
    assert.equal(Object.prototype.hasOwnProperty.call(task, 'pendingAttachments'), false, '空附件记录应被清掉，别留在任务里');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createAndStartScheduledTask（调度器路径）：内置附件同样在启动前物化进 inputs.附件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-attach-sched-'));
  const ws = join(root, 'ws');
  try {
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store, recorded } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    const service = createKnjWorkflowSchedulerService(store, bridge);

    // 调度器路径不走 HTTP 路由：附件必须由 startTask 这一个 owner 保证物化
    const staged = await uploads.stage({ name: '定时附件.md', dataBase64: Buffer.from('S', 'utf8').toString('base64') });
    const launched = await service.createAndStartScheduledTask({
      workflowId: 'wf1', title: '定时任务', cwd: ws,
      attachments: [{ uploadId: staged.uploadId, name: staged.name }],
    });

    const dest = join(ws, '.knj-inputs', launched.taskId, '定时附件.md');
    assert.ok(existsSync(dest), '调度器路径创建的附件也必须物化（它不走路由）');
    assert.equal(recorded.engineStartOpts?.args?.inputs?.['附件'], dest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createAndStartScheduledTask：附件条目缺 uploadId → 拒绝创建（与路由同一套校验）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-attach-sched2-'));
  try {
    const uploads = new UploadStore(join(root, 'uploads'));
    const { ctx, store, recorded } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    const service = createKnjWorkflowSchedulerService(store, bridge);
    await assert.rejects(
      () => service.createAndStartScheduledTask({ workflowId: 'wf1', title: 'T', cwd: join(root, 'ws'), attachments: [{ name: 'no-id.md' }] }),
      (e) => /uploadId/.test(e.message),
    );
    assert.equal(recorded.engineStartOpts, null, '不得启动 run');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('materializeAttachments：越界暂存名被压平进任务输入目录（穿越名绝不能逃出 .knj-inputs/<taskId>/）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-attach4-'));
  try {
    const stagingDir = join(root, 'uploads', 'up-xxxx-12345678');
    await mkdir(stagingDir, { recursive: true });
    const stagingFile = join(stagingDir, 'a.md');
    await writeFile(stagingFile, 'E', 'utf8');

    const uploads = new UploadStore(join(root, 'uploads'));
    // 上游给的是穿越名（真实链路里 sanitizeFileName 已会压平；这里证明整条链路的结果是"关在里面"）
    uploads.resolve = async () => ({ uploadId: 'up-xxxx-12345678', name: '..\\..\\evil.md', dir: stagingDir, path: stagingFile });

    const { ctx, store } = makeStartEnv(join(root, 'tasks'));
    const bridge = new WorkflowBridge(ctx, store, 'script', uploads);
    const ws = join(root, 'ws');
    const task = {
      id: 'task-esc', title: 'T', workflowId: 'wf1', cwd: ws,
      pendingAttachments: [{ uploadId: 'up-xxxx-12345678', name: '..\\..\\evil.md' }],
    };

    await bridge.startTask(task, {});

    const dest = join(ws, '.knj-inputs', 'task-esc', 'evil.md');
    assert.equal(task.inputs['附件'], dest, '穿越名必须被压平成任务输入目录内的 basename');
    assert.equal(existsSync(dest), true, '文件应落在 <cwd>/.knj-inputs/<taskId>/ 内');
    assert.equal(existsSync(join(ws, '.knj-inputs', 'evil.md')), false, '不得写到 <taskId>/ 之外');
    assert.equal(existsSync(join(root, 'evil.md')), false, '不得写到工作区之外');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assertInsideDir：越界目标一律拒绝（护栏不能只有 sanitize 一层，必须本身被验证过）', () => {
  const dir = join(tmpdir(), 'knj-guard', '.knj-inputs', 'task-1');
  // 正常名（含中文/序号前缀）放行
  assert.doesNotThrow(() => assertInsideDir(dir, join(dir, '需求说明.docx')));
  assert.doesNotThrow(() => assertInsideDir(dir, join(dir, '2-接口.md')));
  // dir 本身、上一级、跨盘绝对路径 —— 全部拒绝
  assert.throws(() => assertInsideDir(dir, dir), /越界/);
  assert.throws(() => assertInsideDir(dir, join(dir, '..', 'outside.md')), /越界/);
  assert.throws(() => assertInsideDir(dir, join(dir, '..', '..', 'evil.md')), /越界/);
  assert.throws(() => assertInsideDir(dir, join(tmpdir(), 'elsewhere.md')), /越界/);
  assert.throws(() => assertInsideDir(dir, 'D:\\evil.md'), /越界/);
});

test('startTask: 超阈值需求经 args.task.inputDescription 注入「头部摘录 + 文件指针」', async () => {
  const { ctx, store, recorded } = makeEnv();
  const bridge = new WorkflowBridge(ctx, store, 'script');
  const task = makeTask();
  task.description = '需'.repeat(INLINE_MAX + 2000);
  task.descriptionFile = 'D:/data/tasks/task-x/requirement.md';
  await bridge.startTask(task, {});

  const injected = recorded.engineStartOpts?.args?.task?.inputDescription;
  assert.ok(injected, 'args.task 必须带 Host 预计算的 inputDescription');
  assert.equal(injected, formatInputDescription(task), '注入文本应与 lib/requirement.js 的格式化结果一致');
  assert.ok(injected.startsWith('需'.repeat(HEAD_MAX)), '应以头部摘录开头');
  assert.ok(injected.includes(task.descriptionFile), '应指向落盘的完整需求文件');
  assert.ok(!injected.includes('需'.repeat(INLINE_MAX + 1)), '不得把全文塞进 prompt');
  assert.equal(recorded.engineStartOpts?.args?.task?.description, undefined,
    '超阈值时不再把全文塞进 args（体积与子 agent 上下文都要控住）');
});

test('startTask: 阈值内需求 args.task.description 保持原样（旧语义不变）', async () => {
  const { ctx, store, recorded } = makeEnv();
  const bridge = new WorkflowBridge(ctx, store, 'script');
  const task = makeTask();
  task.description = '短需求';
  await bridge.startTask(task, {});

  assert.equal(recorded.engineStartOpts?.args?.task?.description, '短需求');
  assert.equal(recorded.engineStartOpts?.args?.task?.inputDescription, '短需求');
});

test('orchestrator 脚本：${inputDescription} 读取 Host 预计算字段（沙箱无 require，禁止在此重复实现阈值）', () => {
  const script = readFileSync(join(import.meta.dirname, 'orchestrator.js'), 'utf8');
  assert.match(script, /inputDescription: typeof task\.inputDescription === 'string'/,
    '脚本应直接用 args.task.inputDescription，缺失时回退 task.description');
  assert.ok(!/INLINE_MAX/.test(script), '脚本文本不得再定义一份阈值常量（会与 lib/requirement.js 漂移）');
});

test('startTask: 专用 parent 必须挂 agent preset（setup 调 agentPresets.mount）', async () => {
  const { ctx, store, recorded } = makeEnv();
  const bridge = new WorkflowBridge(ctx, store, 'script');
  await bridge.startTask(makeTask(), {});

  assert.ok(recorded.createOpts, 'agents.create 应被调用');
  assert.equal(typeof recorded.createOpts.setup, 'function',
    'agents.create 必须传 setup：否则 parent（及其全部 workflow subagent）不挂 preset，' +
    'skill 工具/catalog 与 write/bash 等 preset 层工具全部缺失');
  const agentCtx = { tag: 'parent-scope' };
  await recorded.createOpts.setup(agentCtx);
  assert.equal(recorded.mountCalls.length, 1, 'setup 应调用 agentPresets.mount 一次');
  assert.equal(recorded.mountCalls[0][0], 'parent-scope', 'mount 收到的是 agent scope ctx');
});

test('startTask: meta.agentPreset 需写入会话头（继承 seed 的 preset）', async () => {
  const { ctx, store, recorded } = makeEnv({ seedPreset: 'standard' });
  const bridge = new WorkflowBridge(ctx, store, 'script');
  await bridge.startTask(makeTask(), {});
  assert.equal(recorded.createOpts?.meta?.agentPreset, 'standard',
    'header 在 session 边界快照 meta 时定型，preset id 必须随 meta 传入（供持久化/前端展示/subagent 继承语义）');
});

test('startTask: seed 无 preset 时用默认 preset（resolve(undefined) → defaultId）', async () => {
  const { ctx, store, recorded } = makeEnv({ seedPreset: undefined });
  const bridge = new WorkflowBridge(ctx, store, 'script');
  await bridge.startTask(makeTask(), {});
  assert.equal(typeof recorded.createOpts?.setup, 'function');
  await recorded.createOpts.setup({ tag: 'x' });
  assert.equal(recorded.mountCalls[0]?.[1], 'standard', 'resolve(undefined) 应回落到默认 preset id');
  assert.equal(recorded.createOpts.meta?.agentPreset, 'standard');
});

test('startTask: 无 agentPresets 服务时优雅降级（不传 setup 也不炸）', async () => {
  const { ctx, store, recorded } = makeEnv({ presetService: 'none' });
  const bridge = new WorkflowBridge(ctx, store, 'script');
  await bridge.startTask(makeTask(), {});
  assert.ok(recorded.createOpts, '仍应创建专用 parent');
  assert.equal(recorded.createOpts.setup, undefined,
    '无 roster 部署没有 preset 可挂，行为应与 apiproxy composeAgent 一致：什么都不挂');
  assert.equal(recorded.engineStartOpts?.parent?.id, 'parent-1', 'workflow 引擎仍以专用 parent 启动');
});

test('startTask: 无活跃会话但任务带 cwd → 仍自建专用 parent（默认 preset）', async () => {
  const { ctx, store, recorded } = makeEnv({ live: 'none' });
  const bridge = new WorkflowBridge(ctx, store, 'script');
  const task = makeTask(); // cwd: 'D:/w'
  await bridge.startTask(task, {});

  assert.ok(recorded.createOpts, '无 seed 也应自建专用 parent（此前直接抛 no active agent）');
  assert.equal(recorded.createOpts.meta?.cwd, 'D:/w', 'cwd 来自任务配置');
  assert.equal(recorded.createOpts.meta?.agentPreset, 'standard', '无 seed 时 resolve(undefined) 回落默认 preset');
  assert.equal(recorded.createOpts.agentOptions?.model, undefined, '无 seed 无任务模型时省略 model → 宿主默认');
  assert.equal(recorded.engineStartOpts?.parent?.id, 'parent-1', 'workflow 引擎以自建 parent 启动');
});

test('startTask: 无活跃会话且无 cwd → 抛可操作错误（指引选工作目录/先开会话）', async () => {
  const { ctx, store, recorded } = makeEnv({ live: 'none' });
  const bridge = new WorkflowBridge(ctx, store, 'script');
  const task = makeTask();
  delete task.cwd;

  await assert.rejects(
    () => bridge.startTask(task, {}),
    (err) => /工作目录/.test(err.message) && /no active agent|会话/.test(err.message),
    '错误信息必须说清「无法确定工作目录」并给出可照做的下一步，而不是裸的内部错误');
  assert.equal(recorded.createOpts, null, '无 cwd 无 seed 时不应调用 agents.create（建出来 subagent 也会因缺 cwd 失败）');
});

test('startTask: run 终态后必须调用 run.dispose（否则引擎占用 parent machine，parent 永不注销）', async () => {
  const { ctx, store, recorded } = makeEnv();
  const bridge = new WorkflowBridge(ctx, store, 'script');
  await bridge.startTask(makeTask(), {});
  // run.result 立即 resolve，.then 回调（finalizeTask → 清理 → dispose）在微任务链执行：
  // setImmediate 排空后再断言，保证回调已跑完。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recorded.runDisposeCalls, 1,
    'result 落定后应恰好调用一次 run.dispose()（holder 契约，与 dsh-tool-workflow 的 finally { await run.dispose() } 对齐）；' +
    '否则引擎 run 不释放，parentHandle.dispose 挂在 machine.whenIdle() 上，knj-task-* parent 永久泄漏');
});

test('scheduler service resolves latest workflow and starts a fresh task', async () => {
  const saved = [];
  const started = [];
  const workflow = { ...WF, revision: 2 };
  const store = {
    getWorkflow: async (id) => id === 'wf1' ? workflow : null,
    listWorkflows: async () => [workflow],
    saveTask: async (task) => { saved.push({ ...task }); },
    mutateTask: async () => {},
  };
  const service = createKnjWorkflowSchedulerService(store, {
    async startTask(task) { started.push(task); task.parentSessionId = 'parent-scheduled'; return { runId: 'run-scheduled' }; },
  });

  const result = await service.createAndStartScheduledTask({
    workflowId: 'wf1', title: 'Morning report', storyCode: 'US-123', cwd: 'D:/workspace/project',
  });

  assert.ok(saved.length >= 1, '任务应在启动前持久化');
  assert.equal(started.length, 1);
  assert.equal(started[0].workflowId, 'wf1');
  assert.equal(started[0].storyCode, 'US-123', '调度启动必须透传可选用户故事编码');
  assert.equal(started[0].workflowRevision, 2);
  assert.equal(started[0].workflowSnapshot, undefined);
  assert.equal(result.taskId, started[0].id);
  assert.equal(result.parentSessionId, 'parent-scheduled');
  assert.equal(result.runId, 'run-scheduled');
});

test('scheduler service rejects a missing workflow before starting', async () => {
  let started = false;
  const service = createKnjWorkflowSchedulerService({
    getWorkflow: async () => null,
    listWorkflows: async () => [],
    saveTask: async () => {},
    mutateTask: async () => {},
  }, {
    async startTask() { started = true; return { runId: 'unexpected' }; },
  });

  await assert.rejects(
    () => service.createAndStartScheduledTask({ workflowId: 'gone', title: 'Missing', cwd: 'D:/workspace/project' }),
    /workflow not found: gone/i,
  );
  assert.equal(started, false);
});

// ---------------------------------------------------------------------------
// 并发守卫（W1）：同一任务同时只能有一个活跃 run
// ---------------------------------------------------------------------------
test('startTask: 任务已有活跃 run 时必须拒绝再次启动（双份 subagent 并行 = 双倍 LLM 成本）', async () => {
  const runs = [];
  const engine = {
    start() {
      const run = {
        id: `run-${runs.length + 1}`,
        cancel() { runs.cancelled = (runs.cancelled || 0) + 1; },
        dispose() {},
        result: new Promise(() => {}), // 永不落定：模拟长跑中的 run
      };
      runs.push(run);
      return run;
    },
  };
  const parentAgent = {
    id: 'parent-1',
    scope: { ctx: { get: (n) => (n === 'workflowEngine' ? engine : undefined) } },
  };
  const seed = { session: { header: { cwd: 'D:/w' } }, options: {} };
  const ctx = {
    on() {}, off() {},
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'agents') return { currentInitiator: () => seed, roots: () => [seed], async create() { return { agent: parentAgent, dispose: async () => {} }; } };
      return undefined;
    },
  };
  const store = { tasksDir: '.tasks', getWorkflow: async () => WF, saveTask: async () => {}, mutateTask: async () => {}, saveResults: async () => {}, writeStage: async () => {} };
  const bridge = new WorkflowBridge(ctx, store, 'script');

  const first = await bridge.startTask(makeTask(), {});
  assert.ok(first.runId, '第一次启动应成功');
  await assert.rejects(
    () => bridge.startTask(makeTask(), {}),
    (err) => /运行中|已有活跃|已有一个 run|already/i.test(err.message),
    '活跃 run 存在时第二次 startTask 必须显式拒绝：静默并行启动会双倍烧 LLM 成本且互相踩 stage 文件');
  assert.equal(runs.length, 1, '第二次调用不得真的启动第二个引擎 run');

  // 清理：取消挂起的 run，结束测试
  bridge.cancelTask(makeTask().id);
});

// ---------------------------------------------------------------------------
// rerun-stage 未知 stageId（W6）：必须 400，不得静默全量重跑
// ---------------------------------------------------------------------------
test('rerun-stage: stageId 不在任务里时返回 400（静默 idx=-1 → beforeIds=[] 会触发全量重跑）', async () => {
  assert.equal(typeof registerRoutes, 'function', 'registerRoutes 应可导出供路由级测试');
  let started = 0;
  const bridge = {
    isRunning: () => false,
    startTask: async () => { started += 1; return { runId: 'r-1' }; },
    cancelTask() {},
  };
  const task = {
    id: 'task-x', title: 'T', status: 'completed',
    workflowSnapshot: WF,
    stageStates: [{ id: 'n1', title: '做一件事', status: 'done' }],
  };
  const store = {
    tasksDir: '.tasks',
    getTask: async (id) => (id === 'task-x' ? { ...task } : null),
    saveTask: async () => {},
    mutateTask: async () => {},
    readResults: async () => ({}),
    readStage: async () => null,
  };
  const registrations = [];
  const fakeCtx = {
    effect(fn) { fn(); return () => {}; },
    webServer: { register: (r) => registrations.push(r) },
  };
  registerRoutes(fakeCtx, store, bridge, '');
  const handler = registrations[0].handler;

  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/tasks/task-x/rerun-stage';
  const res = {
    headersSent: false, statusCode: 0, body: null,
    writeHead(s) { this.statusCode = s; this.headersSent = true; },
    end(d) { this.body = d ? JSON.parse(d) : null; },
  };
  process.nextTick(() => {
    req.emit('data', JSON.stringify({ stageId: 'ghost-stage' }));
    req.emit('end');
  });
  await handler(req, res);

  assert.equal(res.statusCode, 400, '未知 stageId 必须 400');
  assert.match(res.body?.error || '', /ghost-stage|not found|stageId/i, '错误信息应指出 stageId 不存在');
  assert.equal(started, 0, '不得启动 run（旧行为会静默全量重跑整个工作流）');
});

// ---------------------------------------------------------------------------
// 并发守卫加固（TOCTOU + typed error + isRunning 预检）
// ---------------------------------------------------------------------------

/** 构造带「可延迟 getWorkflow」与「永不落定 run」的环境，用于竞态与取消窗口测试。 */
function makeRaceEnv({ getWorkflowDelay = 0 } = {}) {
  const started = [];
  const engine = {
    start() {
      const run = { id: `run-${started.length + 1}`, cancel() {}, dispose() {}, result: new Promise(() => {}) };
      started.push(run);
      return run;
    },
  };
  const parentAgent = { id: 'parent-1', scope: { ctx: { get: (n) => (n === 'workflowEngine' ? engine : undefined) } } };
  const seed = { session: { header: { cwd: 'D:/w' } }, options: {} };
  const ctx = {
    on() {}, off() {},
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'agents') return { currentInitiator: () => seed, roots: () => [seed], async create() { return { agent: parentAgent, dispose: async () => {} }; } };
      return undefined;
    },
  };
  const store = {
    tasksDir: '.tasks',
    async getWorkflow() {
      if (getWorkflowDelay) await new Promise((r) => setTimeout(r, getWorkflowDelay));
      return WF;
    },
    async getTask() { return null; },
    async saveTask() {}, async mutateTask() {}, async saveResults() {}, async writeStage() {},
  };
  const bridge = new WorkflowBridge(ctx, store, 'script');
  return { bridge, started, store };
}

test('startTask: 并发双启动只有一个成功（同步占位堵 TOCTOU 竞态）', async () => {
  const { bridge, started } = makeRaceEnv({ getWorkflowDelay: 20 });
  const results = await Promise.allSettled([
    bridge.startTask(makeTask(), {}),
    bridge.startTask(makeTask(), {}),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, '并发双启动必须恰好一个成功');
  assert.equal(rejected.length, 1, '另一个必须被拒绝');
  assert.ok(rejected[0].reason instanceof RunAlreadyActiveError, '拒绝原因必须是 RunAlreadyActiveError');
  assert.equal(started.length, 1, '引擎只启动一个 run（不得双份 subagent）');
  assert.equal(bridge.isRunning(makeTask().id), true, '任务应处于运行中');
});

test('startTask: 已有活跃 run 时抛 RunAlreadyActiveError，isRunning 反映占位/活跃态', async () => {
  const { bridge } = makeRaceEnv();
  await bridge.startTask(makeTask(), {});
  assert.equal(bridge.isRunning(makeTask().id), true);
  await assert.rejects(
    () => bridge.startTask(makeTask(), {}),
    (e) => e instanceof RunAlreadyActiveError,
    '必须抛 RunAlreadyActiveError（路由层据此回 409 不标 failed）');
});

test('resume 路由：isRunning 预检在改状态前 409，任务不被误标 failed', async () => {
  // bridge.isRunning=true（取消落定前的窗口），路由必须在 mutateTask 之前就 409 返回
  const bridge = { isRunning: () => true, startTask: async () => { throw new Error('should not reach'); } };
  let mutated = false;
  const task = { id: 'task-x', title: 'T', status: 'cancelled', workflowSnapshot: WF, stageStates: [{ id: 'n1', title: 'A', status: 'done' }] };
  const store = {
    tasksDir: '.tasks',
    async getTask(id) { return id === 'task-x' ? { ...task } : null; },
    async saveTask() {}, async mutateTask() { mutated = true; }, async readResults() { return {}; }, async readStage() { return null; },
  };
  const registrations = [];
  registerRoutes({ effect(fn) { fn(); return () => {}; }, webServer: { register: (r) => registrations.push(r) } }, store, bridge, '');
  const handler = registrations[0].handler;

  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/tasks/task-x/resume';
  const res = { headersSent: false, statusCode: 0, body: null, writeHead(s) { this.statusCode = s; this.headersSent = true; }, end(d) { this.body = d ? JSON.parse(d) : null; } };
  process.nextTick(() => { req.emit('data', JSON.stringify({ mode: 'resume' })); req.emit('end'); });
  await handler(req, res);

  assert.equal(res.statusCode, 409, '取消中续跑必须 409');
  assert.equal(mutated, false, '不得 mutateTask 把任务误标 failed');
});
