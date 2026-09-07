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
import { WorkflowBridge, registerRoutes, RunAlreadyActiveError, createKnjWorkflowSchedulerService } from './index.js';

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
    getWorkflow: async () => WF,
    saveTask: async () => {},
    mutateTask: async () => {},
    saveResults: async () => {},
    writeStage: async () => {},
  };
  return { ctx, store, recorded, agents };
}

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
