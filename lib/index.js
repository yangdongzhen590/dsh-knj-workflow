/**
 * dsh-knj-workflow Host 端
 * ---------------------------------------------------------------
 * 功能：
 *   1. 工作流 CRUD（workflows.json，全局 ~/.dsh/dev-orchestrator/）
 *   2. 开发任务 CRUD（tasks/<id>/task.json），任务绑定工作流
 *   3. 任务启动/取消/暂停/重跑阶段/继续 —— 桥接 ctx.workflowEngine
 *   4. HTTP API（默认前缀 /devtask）供 Client UI 调用
 *   5. /dev-task 命令注册（命令平面，结果不进模型上下文）
 *   6. 监听 workflow/phase、workflow/agent-end、workflow/end 事件更新任务进度
 */
import { homedir } from 'node:os';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { mkdir, readFile, writeFile, readdir, rm, rename, stat, realpath, copyFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { validateWorkflow, prepareWorkflowForSave, orderTaskNodesByFlow, declaredFileInputs, validateWorkflowInputs } from './graph.js';
import { summarizeWorkflow, buildAssistPrompt } from './assist-prompt.js';
import { applyEdits } from './assist-edits.js';
import {
  deriveTaskTitle,
  needsRequirementFile,
  normalizeRequirementText,
  countChars,
  formatInputDescription,
  INLINE_MAX,
  REQUIREMENT_FILE_NAME,
} from './requirement.js';
import { UploadStore, UploadError, sanitizeFileName, WORKSPACE_INPUT_DIR, UPLOAD_BODY_BYTES } from './uploads.js';
import { materializeAttachments, normalizeAttachmentRefs, describeAttachmentsError } from './attachments.js';

// ---- 运行时诊断日志（排查 runs 生命周期：human 决策后任务卡 running）----
// 只记录关键状态转换，避免刷屏；写入独立文件便于事后查看，不依赖宿主 logger 落点。
const DEBUG_LOG_DIR = join(homedir(), '.dsh', 'dev-orchestrator');
const DEBUG_LOG = join(DEBUG_LOG_DIR, 'knj-host-debug.log');
let _dbgInited = false;
function dbg(event, data) {
  try {
    if (!_dbgInited) { mkdirSync(DEBUG_LOG_DIR, { recursive: true }); _dbgInited = true; }
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    appendFileSync(DEBUG_LOG, line + '\n', 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

export const name = 'dsh-knj-workflow';

export const Config = z.object({
  dataRoot: z.string().default(''),
  httpPrefix: z.string().default('/devtask'),
  orchestratorScript: z.string().default(''),
});

// `workflowEngine` is intentionally NOT injected: since rc.8 the engine lives
// inside the agent-preset realm (the standard preset's delegation group), not
// in the host realm this plugin mounts in. It is resolved lazily from the
// owning agent's scope when a run starts (see WorkflowBridge.startTask).
export const inject = ['webServer', 'agents'];

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
async function exists(p) {
  try { await readFile(p); return true; } catch { return false; }
}
async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')); }
  catch { return fallback; }
}
async function writeJson(p, value) {
  await mkdir(dirname(p), { recursive: true });
  const data = JSON.stringify(value, null, 2);
  // 原子写：先写 tmp 再 rename。直接 writeFile 在写一半崩溃（进程被杀/断电）会留下
  // 截断的 JSON，下次 load 只能整库丢弃；tmp+rename 崩溃最多丢 tmp 文件，目标保持完整旧内容。
  // Windows 上 rename 到已存在目标偶发 EPERM（目标被占用）→ 回退直接写 + 小规模重试。
  const tmp = `${p}.tmp-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  try {
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, p);
    return;
  } catch { /* 回退路径 */ }
  await rm(tmp, { force: true }).catch(() => {});
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(p, data, 'utf8');
      return;
    } catch (error) {
      lastErr = error;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
  throw lastErr;
}
function nowIso() { return new Date().toISOString(); }

/** 历史决策 → { humanId: label }（每个 human 取最后一条）。
 *  resume/decide 重走图时传给编排器：已审批过的 human 直接走最后去向、不再暂停，
 *  否则两个顺序人工节点的任务会在 H1/H2 之间无限振荡（后一个决策被前一个的重新暂停吞掉）。 */
function buildDecidedMap(task) {
  const map = {};
  for (const d of (task.decisions || [])) {
    if (d && d.humanId && d.decision) map[d.humanId] = d.decision;
  }
  return map;
}

// ---------------------------------------------------------------------------
// 数据层 DevTaskStore
// ---------------------------------------------------------------------------
export class DevTaskStore {
  constructor(root) {
    this.root = root;
    this.workflowsFile = join(root, 'workflows.json');
    this.tasksDir = join(root, 'tasks');
    this._queues = new Map(); // taskId -> Promise 链（串行化同一任务的写）
    this._wfQueue = Promise.resolve(); // workflows.json 读-改-写串行化链
  }

  /** workflows.json 的读-改-写互斥：并发的 save/delete 互相覆盖会丢修改 */
  _wfMutate(fn) {
    const next = this._wfQueue.then(fn, fn);
    this._wfQueue = next.catch(() => {});
    return next;
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.tasksDir, { recursive: true });
    return this._wfMutate(async () => {
      const wf = await readJson(this.workflowsFile, { workflows: [] });
      if (!Array.isArray(wf.workflows)) wf.workflows = [];
      // 旧线性格式（含 stages、无 nodes/edges）直接废弃，不迁移
      const before = wf.workflows.length;
      wf.workflows = wf.workflows.filter((w) => !(Array.isArray(w.stages) && !Array.isArray(w.nodes)));
      if (wf.workflows.length === 0) {
        wf.workflows = [defaultWorkflow()];
      }
      if (wf.workflows.length !== before) {
        await writeJson(this.workflowsFile, wf);
      }
    });
  }

  async listWorkflows() {
    const wf = await readJson(this.workflowsFile, { workflows: [] });
    return wf.workflows || [];
  }
  async getWorkflow(id) {
    const list = await this.listWorkflows();
    return list.find((w) => w.id === id);
  }
  async saveWorkflow(workflow) {
    return this._wfMutate(async () => {
      const existing = await this.getWorkflow(workflow?.id);
      const prep = prepareWorkflowForSave(workflow, existing);
      if (!prep.ok) throw new Error(`workflow 校验失败: ${prep.errors.join('; ')}`);
      const prepared = prep.workflow;
      const wf = await readJson(this.workflowsFile, { workflows: [] });
      const i = wf.workflows.findIndex((w) => w.id === prepared.id);
      if (i === -1) wf.workflows.push(prepared);
      else wf.workflows[i] = prepared;
      await writeJson(this.workflowsFile, wf);
      return prepared;
    });
  }
  async deleteWorkflow(id) {
    return this._wfMutate(async () => {
      const wf = await readJson(this.workflowsFile, { workflows: [] });
      wf.workflows = wf.workflows.filter((w) => w.id !== id);
      await writeJson(this.workflowsFile, wf);
    });
  }

  /** 校验任务/阶段 id，防止路径穿越（%2e%2e%2f 解码后进 join 可任意读写/删目录）。
   *  `.` 单独也必须拒：它虽不含 `..`，但 `join(tasksDir, '.')` 会落到 tasksDir 根，
   *  把任务的 task.json / requirement.md 写进所有任务目录都在的那一层。 */
  static assertSafeId(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(id) || id.includes('..') || /^\.+$/.test(id)) {
      throw new Error(`invalid id: ${id}`);
    }
  }
  taskFile(id) { DevTaskStore.assertSafeId(id); return join(this.tasksDir, id, 'task.json'); }
  stageFile(taskId, stageId) { DevTaskStore.assertSafeId(taskId); DevTaskStore.assertSafeId(stageId); return join(this.tasksDir, taskId, 'stages', `${stageId}.json`); }
  resultsFile(taskId) { DevTaskStore.assertSafeId(taskId); return join(this.tasksDir, taskId, 'results.json'); }

  /**
   * 任务列表。归档过滤（SPEC-board-redesign 增量）：
   *  - { archived: true }  只返回已归档（archivedAt 有值）
   *  - { archived: false } 只返回主列表（未归档）
   *  - 缺省/undefined      返回全部（内部与兼容路径）
   * 关键词过滤（{ q }）：**在 Host 侧对完整需求正文匹配**——列表项已不再携带
   *  description（看板每 3s 轮询，十万字需求不能反复传输），客户端无法再自行过滤正文，
   *  所以正文搜索必须在这一层完成，否则「搜索需求里的词」会静默失效。
   */
  async listTasks(filter = {}) {
    const out = [];
    const q = typeof filter.q === 'string' ? filter.q.trim().toLowerCase() : '';
    let dirs = [];
    try { dirs = await readdir(this.tasksDir); } catch { return out; }
    for (const d of dirs) {
      const t = await readJson(this.taskFile(d), null);
      if (!t) continue;
      if (filter.archived === true && t.archivedAt === undefined) continue;
      if (filter.archived === false && t.archivedAt !== undefined) continue;
      if (q) {
        const hay = `${t.title || ''}\n${t.description || ''}\n${t.workflowId || ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      // 列表不需要完整工作流配置（每个可能几十 KB，且每 3 秒轮询），剥掉以减轻传输与解析。
      // 详情页用 getTask 拿完整快照。需求正文同理：只留字数供 UI 提示。
      const { workflowSnapshot, description, ...rest } = t;
      out.push({ ...rest, descriptionChars: countChars(description) });
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  async getTask(id) {
    return await readJson(this.taskFile(id), null);
  }
  async saveTask(task) {
    await mkdir(join(this.tasksDir, task.id), { recursive: true });
    const file = this.taskFile(task.id);
    // 串行化同一任务的写入：事件回调（phase/agent-end/end）可能并发触发 saveTask，
    // Windows 上并发写同一文件会互相踩踏。
    const prev = this._queues.get(task.id) || Promise.resolve();
    dbg('store.saveTask: 排队', { taskId: task.id, queueDepth: this._queues.has(task.id) ? 1 : 0 });
    const next = prev.then(async () => {
      await writeJson(file, task);
      dbg('store.saveTask: 写盘完成', { taskId: task.id });
    });
    this._queues.set(task.id, next.catch(() => {})); // 队列本身吞掉错误，避免整链断掉
    await next;
    dbg('store.saveTask: await 返回', { taskId: task.id });
    return task;
  }
  /**
   * 事务化 read-modify-write：在队列内串行「读最新快照 → mutator 原地修改 → 写盘」。
   * 并发事件回调（phase/agent-start/agent-end）都用它，避免各自 getTask 拿到旧快照、
   * 后写覆盖先写（此前导致 stageStates 的 status 一直 pending、进度不更新）。
   */
  async mutateTask(id, mutator) {
    await mkdir(join(this.tasksDir, id), { recursive: true });
    const file = this.taskFile(id);
    const prev = this._queues.get(id) || Promise.resolve();
    dbg('store.mutateTask: 排队', { taskId: id, queueDepth: this._queues.has(id) ? 1 : 0 });
    const next = prev.then(async () => {
      const t = await readJson(file, null);
      if (!t) return null;
      await mutator(t);
      await writeJson(file, t);
      dbg('store.mutateTask: 写盘完成', { taskId: id });
      return t;
    });
    this._queues.set(id, next.catch(() => {}));
    const out = await next;
    dbg('store.mutateTask: await 返回', { taskId: id });
    return out;
  }
  async deleteTask(id) {
    DevTaskStore.assertSafeId(id);
    await rm(join(this.tasksDir, id), { recursive: true, force: true });
  }
  async readStage(taskId, stageId) {
    return await readJson(this.stageFile(taskId, stageId), null);
  }
  async writeStage(taskId, stageId, data) {
    await writeJson(this.stageFile(taskId, stageId), data);
  }
  async saveResults(taskId, results) {
    await writeJson(this.resultsFile(taskId), results || {});
  }
  async readResults(taskId) {
    return await readJson(this.resultsFile(taskId), null);
  }
}

// ---------------------------------------------------------------------------
// 默认工作流（首次启动种子）
// ---------------------------------------------------------------------------
function defaultWorkflow() {
  const task = (id, title, prompt, output, inputs = [], mode = 'single', parallelItems = undefined) => ({
    id,
    type: 'task',
    title,
    inputs,
    body: {
      prompt,
      skill: null,
      mode,
      ...(parallelItems ? { parallelItems } : {}),
      output,
    },
    prehook: [],
    posthook: [],
  });
  return {
    id: 'wf-dev-pipeline',
    name: '开发任务流水线',
    description: '需求 → 初始化目录 → 分析设计 → 编码 → 评审',
    schemaVersion: 2,
    revision: 1,
    inputs: [],
    nodes: [
      { id: 'start', type: 'start' },
      task('fetch-requirement', '获取需求详情',
        '读取工作区 openspec/changes/ 目录下最近的 change 文件（或用户指定的需求来源），提取结构化需求：标题、背景、功能描述、验收标准、优先级。',
        {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            acceptanceCriteria: { type: 'array', items: { type: 'string' } },
            source: { type: 'string' },
          },
          required: ['title', 'description', 'acceptanceCriteria'],
          additionalProperties: false,
        }),
      task('init-task-dir', '初始化任务目录',
        '用 pwsh 在工作区创建任务目录 .tasks/<需求id或短标题>/，内含 docs/ 与 src/ 子目录，输出实际创建的目录路径。',
        {
          type: 'object',
          properties: { taskDir: { type: 'string' }, created: { type: 'boolean' } },
          required: ['taskDir', 'created'],
          additionalProperties: false,
        },
        [{ from: 'fetch-requirement', field: '*' }]),
      task('design', '功能分析设计',
        '基于上游需求与代码现状编写任务目录下 docs/design.md：涉及模块、改动清单、接口设计、风险点、实施顺序。若需可视化，可自行用文本描述架构图，不要依赖额外 skill。',
        {
          type: 'object',
          properties: {
            designDoc: { type: 'string' },
            affectedFiles: { type: 'array', items: { type: 'string' } },
            plan: { type: 'array', items: { type: 'string' } },
          },
          required: ['designDoc', 'affectedFiles', 'plan'],
          additionalProperties: false,
        },
        [{ from: 'fetch-requirement', field: '*' }, { from: 'init-task-dir', field: '*' }]),
      task('implement', '实施编码',
        '读取设计文档与相关代码，用 edit/write 实现功能，记录改动文件清单。',
        {
          type: 'object',
          properties: {
            changedFiles: { type: 'array', items: { type: 'string' } },
            summary: { type: 'string' },
          },
          required: ['changedFiles', 'summary'],
          additionalProperties: false,
        },
        [{ from: 'design', field: '*' }]),
      task('review-code', '评审代码',
        '评审代码改动，输出问题清单（文件+行号+严重级别）。你的视角：正确性与逻辑 / 安全与健壮性 / 代码质量与风格。',
        {
          type: 'object',
          properties: {
            viewpoint: { type: 'string' },
            verdict: { type: 'string' },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  file: { type: 'string' }, line: { type: 'string' },
                  severity: { type: 'string' }, detail: { type: 'string' },
                },
                required: ['file', 'line', 'severity', 'detail'],
                additionalProperties: false,
              },
            },
          },
          required: ['viewpoint', 'verdict', 'issues'],
          additionalProperties: false,
        },
        [{ from: 'implement', field: '*' }], 'parallel', 3),
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'fetch-requirement' },
      { from: 'fetch-requirement', to: 'init-task-dir' },
      { from: 'init-task-dir', to: 'design' },
      { from: 'design', to: 'implement' },
      { from: 'implement', to: 'review-code' },
      { from: 'review-code', to: 'end' },
    ],
  };
}

// ---------------------------------------------------------------------------
// workflow 桥接：启动、事件监听
// ---------------------------------------------------------------------------

/** 并发守卫错误：路由层据此区分「已有运行中的 run」与「真实启动失败」——
 *  前者回 409 且不改任务状态（不误标 failed），后者才标 failed。 */
export class RunAlreadyActiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RunAlreadyActiveError';
  }
}

/**
 * Optional host service consumed by dsh-scheduler. It deliberately owns
 * workflow lookup and task construction so callers cannot depend on the
 * workflow store or invoke the HTTP API through a loopback request.
 */
export function createKnjWorkflowSchedulerService(store, bridge) {
  return {
    async listWorkflows() {
      const workflows = await store.listWorkflows();
      return workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        ...(workflow.revision == null ? {} : { revision: workflow.revision }),
        // 声明的任务输入参数（供调用方按类型渲染：text → 输入框，file → 路径字段）；
        // 没有声明时返回空数组，形状稳定，调用方不必区分 undefined。
        inputs: validateWorkflowInputs(workflow.inputs).inputs,
      }));
    },

    /**
     * 为「反复触发」的调用方（调度器）把持久化文件重新放进本插件的上传暂存区。
     *
     * 为什么需要它：本插件的暂存是**一次性交接**（物化后 `discard`），而定时任务每次触发都要
     * 重新物化。调度器的附件存在自己的数据目录里，触发前调这里换一份新的 uploadId，
     * 就能复用同一条物化链路，而不必把本插件的暂存目录布局泄漏给调度器。
     *
     * @param {{files?: Array<{path?: unknown, name?: unknown}>}} input
     * @returns {Promise<Array<{uploadId: string, name: string, size: number}>>}
     */
    async stageAttachments({ files } = {}) {
      if (!bridge?.uploads) throw new Error('附件需要上传服务，但当前上下文没有 uploads（请重启 dsh web 后重试）');
      const list = Array.isArray(files) ? files : [];
      const out = [];
      for (const item of list) {
        const path = item && typeof item.path === 'string' ? item.path : '';
        if (!path) continue;
        const data = await readFile(path);
        out.push(await bridge.uploads.stage({
          name: typeof item.name === 'string' && item.name ? item.name : path.split(/[\\/]/).pop(),
          dataBase64: data.toString('base64'),
        }));
      }
      return out;
    },

    async createAndStartScheduledTask({ workflowId, title, description, storyCode, cwd, fileInputs, pathInputs, attachments, attachmentsAreReusable }) {
      const workflow = await store.getWorkflow(workflowId);
      if (!workflow) throw new Error(`workflow not found: ${workflowId}`);
      const taskTitle = typeof title === 'string' ? title.trim() : '';
      const taskCwd = typeof cwd === 'string' ? cwd.trim() : '';
      // 标题不再是必填：与 HTTP 路由同口径 —— 未给标题时由需求描述派生（空描述则用时间戳占位）。
      // 调度器表单已按此对齐（此前它强制用户填标题，与「新建任务」的体验不一致）。
      const derivedTitle = deriveTaskTitle(normalizeRequirementText(description));
      if (!taskCwd) throw new Error('workflow task cwd is required');

      // 文件入参（可选，当前调度器 UI 没有文件字段，但契约与其他创建路径保持一致）：
      // 这里只记待物化，物化统一在 startTask 启动前完成。
      const pendingFileInputs = {};
      if (fileInputs && typeof fileInputs === 'object' && !Array.isArray(fileInputs)) {
        for (const [param, ref] of Object.entries(fileInputs)) {
          if (ref && typeof ref.uploadId === 'string' && ref.uploadId) {
            pendingFileInputs[param] = { uploadId: ref.uploadId, ...(typeof ref.name === 'string' ? { name: ref.name } : {}) };
          }
        }
      }
      // 路径型文件入参（定时任务的推荐形态）：直接进 inputs，启动前由 startTask 解析绝对路径并校验存在。
      // 之所以不在保存/创建时校验存在性：定时任务的典型用法是"该文件稍后由别的流程产出"。
      const taskInputs = {};
      if (pathInputs && typeof pathInputs === 'object' && !Array.isArray(pathInputs)) {
        for (const [param, value] of Object.entries(pathInputs)) {
          if (typeof value === 'string' && value.trim()) taskInputs[param] = value.trim();
        }
      }
      // 必填文件入参：上传（fileInputs）或路径（pathInputs）任一种满足即可
      const missingFiles = declaredFileInputs(workflow)
        .filter((inp) => inp.required && !pendingFileInputs[inp.name] && !taskInputs[inp.name]);
      if (missingFiles.length > 0) {
        throw new Error(`缺少必填文件入参: ${missingFiles.map((x) => x.name).join(', ')}`);
      }
      // 内置通用附件（无需声明）：与路由同一套 —— 这里只记待物化，物化统一在 startTask 启动前，
      // 保证调度器路径（不走路由）与表单路径行为一致。
      const pendingAttachments = normalizeAttachmentRefs(attachments);
      const attachmentsError = describeAttachmentsError(pendingAttachments);
      if (attachmentsError) throw new Error(attachmentsError);
      // attachmentsAreReusable：调度器的附件是**持久化**的（存在调度器自己的数据目录里，每次触发
      // 重新调 stageAttachments 换一份暂存）。因此物化后**不能**丢弃暂存、也不清 pendingAttachments
      // —— 否则第二次触发就没有文件了。表单路径（一次性交接）保持默认的丢弃语义。
      const reusableAttachments = attachmentsAreReusable === true;

      const task = {
        id: `task-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
        title: taskTitle || derivedTitle,
        workflowId: workflow.id,
        workflowRevision: workflow.revision || 1,
        // Do not save workflowSnapshot: scheduled launches must resolve the
        // definition that exists at trigger time, not a stale scheduler copy.
        status: 'pending',
        currentStage: null,
        stageStates: orderTaskNodesByFlow(workflow).map((id) => {
          const node = workflow.nodes.find((x) => x.id === id);
          return { id, title: node?.title || id, status: 'pending' };
        }),
        createdAt: nowIso(),
        ...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {}),
        ...(typeof storyCode === 'string' && storyCode.trim() ? { storyCode: storyCode.trim() } : {}),
        ...(Object.keys(taskInputs).length ? { inputs: taskInputs } : {}),
        ...(Object.keys(pendingFileInputs).length ? { pendingFileInputs } : {}),
        // 内置通用附件：固定键 inputs.附件（换行拼接绝对路径），物化在 startTask 启动前
        ...(pendingAttachments.length ? { pendingAttachments } : {}),
        ...(reusableAttachments ? { attachmentsAreReusable: true } : {}),
        cwd: taskCwd,
      };

      await store.saveTask(task);
      try {
        const { runId } = await bridge.startTask(task);
        task.status = 'running';
        task.startedAt = nowIso();
        await store.saveTask(task);
        return {
          taskId: task.id,
          ...(task.parentSessionId ? { parentSessionId: task.parentSessionId } : {}),
          runId,
        };
      } catch (error) {
        await store.mutateTask(task.id, (saved) => {
          saved.status = 'failed';
          saved.error = `启动失败：${error instanceof Error ? error.message : String(error)}`;
          saved.finishedAt = nowIso();
        }).catch(() => {});
        throw error;
      }
    },
  };
}

export class WorkflowBridge {
  constructor(ctx, store, orchestratorScript, uploads) {
    this.ctx = ctx;
    this.store = store;
    this.orchestratorScript = orchestratorScript;
    this.uploads = uploads || null; // 文件入参的上传暂存（物化在 startTask 前）
    this.listeners = new Map(); // taskId -> runId
    this.runs = new Map(); // taskId -> run 引用（用于取消；startTask 期间为同步占位）
    this.parentHandles = new Map(); // runId -> 动态创建的专用 parent handle（按 run 代次管理，防旧 run 误杀新 run 的 parent）
    this.assistRuns = new Map(); // requestId -> { events, done, result, error }（AI 对话过程，供前端轮询）
  }

  /** 任务当前是否有活跃 run（含正在启动的占位）。路由层在改任务状态前先问它，
   *  避免「取消后立即续跑」窗口把任务误标 failed。 */
  isRunning(taskId) {
    return this.runs.has(taskId);
  }

  /**
   * 跑一轮「AI 对话配置工作流」：把用户消息 + 当前图摘要组装成 prompt，
   * 经 workflow 引擎派一个设计 subagent，返回 { reply, edits, childId }。
   * 无状态：图状态由调用方（Client 画布）每次请求带来，Host 不落草稿。
   * @param {object} opts
   * @param {function} [opts.onEvent] 过程事件回调 (kind, text) —— 由 startAssist 收集给前端轮询
   */
  async runAssist({ workflow, message, history, onEvent, onChild } = {}) {
    if (!workflow || typeof workflow !== 'object' || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) {
      throw new Error('workflow 必须是 { nodes, edges } 结构（请传当前画布的工作流草稿）');
    }
    const msg = typeof message === 'string' ? message.trim() : '';
    if (!msg) throw new Error('message 不能为空（请提供本轮修改指令）');
    const emit = typeof onEvent === 'function' ? onEvent : () => {};

    // parent agent：优先当前会话，其次任一 root（assist 是短时推理，不新建专用 parent，
    // 避免为一次对话留下常驻会话）。engine 必须在 agent scope 内解析（同 startTask）。
    const agents = this.ctx.get('agents');
    const parent = agents?.currentInitiator?.() ?? agents?.roots?.()?.[0] ?? null;
    if (!parent) {
      throw new Error('no active agent to own the assist run：请先打开一个会话，再在流程编辑器里使用 AI 助手');
    }
    const scopeCtx = parent.scope?.ctx ?? parent.loopCtx;
    const engine = scopeCtx?.get?.('workflowEngine');
    if (!engine) {
      throw new Error('workflowEngine unavailable in the owning agent scope (is an agent preset with workflow support mounted?)');
    }

    const prompt = buildAssistPrompt({
      summary: summarizeWorkflow(workflow),
      history,
      message: msg,
    });
    const script = this.assistScript || readFileSync(new URL('./assist-script.js', import.meta.url), 'utf8');

    const run = engine.start({
      script,
      meta: { name: 'knj-workflow-assist', description: `AI 助手对话：${msg.slice(0, 60)}` },
      args: { prompt },
      parent,
    });

    // 过程事件：把引擎事件翻译成人能读的过程行（供前端轮询实时显示）
    const startedAt = Date.now();
    let childId = null;
    const listeners = [];
    const on = (name, fn) => {
      try {
        this.ctx.on(name, fn);
        listeners.push([name, fn]);
      } catch { /* 无事件能力的环境忽略 */ }
    };
    const matches = (info) => !info || info.id === run.id;
    emit('start', '已启动设计助手，正在读取当前流程图…');
    on('workflow/agent-start', (info, agent) => {
      if (!matches(info)) return;
      if (agent?.childId) {
        childId = agent.childId;
        // 拿到助手会话 id：立刻开始采集它的实时事件流（正文/推理/工具调用）
        try { onChild?.(childId); } catch { /* 采集失败不影响主流程 */ }
      }
      emit('agent-start', `设计助手已启动${agent?.label ? `（${agent.label}）` : ''}，正在思考改动方案…`);
    });
    on('workflow/agent-end', (info, agent) => {
      if (!matches(info)) return;
      emit('agent-end', `设计助手已返回${agent?.label ? `（${agent.label}）` : ''}，正在解析改动…`);
    });
    on('workflow/log', (info, text) => {
      if (!matches(info) || typeof text !== 'string') return;
      if (text.startsWith('[knj-checkpoint]')) return; // 断点内部协议，不展示
      emit('log', text);
    });
    on('workflow/phase', (info, title) => {
      if (!matches(info) || !title) return;
      emit('phase', `阶段：${title}`);
    });

    try {
      const finished = await run.result;
      const value = finished?.value;
      if (!value || typeof value !== 'object') {
        dbg('runAssist: 无有效产出', { runId: run?.id });
        throw new Error('设计助手无有效产出（run 未返回 { reply, edits }）');
      }
      return {
        reply: typeof value.reply === 'string' ? value.reply : '',
        edits: Array.isArray(value.edits) ? value.edits : [],
        childId,
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      // 监听器用完即摘，避免长期挂载（每轮 assist 都注册一次）
      for (const [name, fn] of listeners) {
        try { this.ctx.off?.(name, fn); } catch { /* best effort */ }
      }
    }
  }

  /**
   * 异步启动一轮对话：立即返回 requestId，后台跑 runAssist 并把过程事件与最终结果
   * 存进 registry（供 GET /assist/progress 轮询）。这样前端能实时显示助手工作过程。
   */
  startAssist({ workflow, message, history } = {}) {
    if (!workflow || typeof workflow !== 'object' || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) {
      throw new Error('workflow 必须是 { nodes, edges } 结构');
    }
    const msg = typeof message === 'string' ? message.trim() : '';
    if (!msg) throw new Error('message 不能为空');

    const requestId = `as-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = { id: requestId, events: [], done: false, result: null, error: null, createdAt: Date.now() };
    this.assistRuns.set(requestId, entry);
    this._pruneAssistRuns();

    const emit = (kind, text) => {
      entry.events.push({ seq: entry.events.length + 1, kind, text: String(text), ts: nowIso() });
    };

    (async () => {
      try {
        const out = await this.runAssist({
          workflow, message: msg, history,
          onEvent: emit,
          // 助手会话一出现就开始采集它的实时事件流（推理 / 正文 / 工具调用）
          onChild: (childId) => this._startAssistStream(entry, childId),
        });
        // edits 在 Host 侧应用（Host 是唯一写图权威）；被拒动作照旧回传原因
        const applied = applyEdits(workflow, out.edits);
        emit('validate', `已校验助手改动：${applied.applied.length} 项生效${applied.rejected.length ? `，${applied.rejected.length} 项被拒` : ''}`);
        emit('done', `完成（用时 ${(out.elapsedMs / 1000).toFixed(1)}s）`);
        entry.result = {
          reply: out.reply,
          workflow: applied.workflow,
          applied: applied.applied,
          rejected: applied.rejected,
          childId: out.childId || null,
          elapsedMs: out.elapsedMs,
        };
      } catch (error) {
        const m = error instanceof Error ? error.message : String(error);
        emit('error', `失败：${m}`);
        entry.error = m;
      } finally {
        // 补采最后一帧：run 结束时助手可能刚写入最后的 chunk（最终回复文本），
        // 若不补采，stream.text 会停在前一次的中间态。null 停止位让 tick 允许跑最后一次。
        entry.done = true;
        entry.finishedAt = Date.now();
        if (entry.streamTimer) { clearTimeout(entry.streamTimer); entry.streamTimer = null; }
        try { await entry.finalTick?.(); } catch { /* 补采失败不影响主流程 */ }
        try { entry.streamOff?.(); } catch { /* 注销失败不影响主流程 */ } // 不留常驻 session/event 监听器
      }
    })();

    return { requestId };
  }

  /**
   * 采集助手子会话的实时事件流 → entry.stream 快照（正文 / 推理 / 工具卡片 / token 用量）。
   *
   * 数据源优先级链（实测结论：listEvents 返回的 SessionEventRecord 只有
   * {sessionId, seq, type, time, surface}，**不含事件体**，读不到 chunk 内容）：
   *   1. readSession(id) → SessionLogSnapshot.events: SessionEvent[]（完整原始事件，含事件体）✅ 主路径
   *   2. readSurface(id) → SessionSurfaceSnapshot.events（折叠后模型表层，可取最终文本/推理）
   *   3. listEvents(id)  → 仅类型，最后兜底（一般无内容）
   * 读取失败逐级回退；全部失败则静默降级（只保留阶段行），绝不影响对话主流程。
   *
   * 事件形状（dsh-session）：assistant/chunk 的 chunk 为 StreamChunk 判别联合
   * （text-delta / reasoning-delta / tool-call-delta / block-start）；另有 tool/call、
   * tool/result、assistant/message（带 usage）。事件体可能是扁平（ev.chunk）或嵌套
   * （ev.payload.chunk / ev.data.chunk），统一用 _evField 兼容提取。
   */
  _startAssistStream(entry, childId) {
    if (!childId || entry.streamStarted || entry.done) return;
    const sq = this.ctx.get?.('sessionQuery');
    if (!sq) {
      dbg('assistStream: sessionQuery 不可用，降级为阶段级过程', { requestId: entry.id });
      return;
    }
    // 候选链 + 运行时回退：读取失败就切到下一级（readSession → readSurface → listEvents）
    const chain = ['readSession', 'readSurface', 'listEvents'].filter((m) => typeof sq[m] === 'function');
    if (chain.length === 0) {
      dbg('assistStream: sessionQuery 无可用的读取方法', { requestId: entry.id });
      return;
    }
    entry.streamStarted = true;
    let idx = 0;
    entry.stream = { text: '', reasoning: '', tools: [], usage: null, diag: { source: chain[0], total: 0, types: {}, live: 0 } };
    let lastKey = -1;
    /** 统一入口：按 seq/seq0 单调去重后并入快照（实时与轮询共用游标，避免重复累积）。 */
    const ingest = (ev) => {
      if (!ev) return;
      const key = Number(ev?.seq ?? ev?.seq0 ?? ev?.time0 ?? ev?.time);
      if (Number.isFinite(key)) {
        if (key <= lastKey) return;
        lastKey = key;
      }
      const t = String(ev.type || '');
      const diag = entry.stream.diag;
      if (t) diag.types[t] = (diag.types[t] || 0) + 1;
      diag.total += 1;
      this._applyAssistEvent(entry.stream, ev);
    };

    // 主通道：会话作用域实时事件（逐条派发，不必等日志 flush）—— 真流式的关键。
    // 实测依据：读持久化日志时前 162s 无数据、172s 一次性到 1878 条（按批 flush），
    // 因此实时性必须来自事件通道，轮询仅作兜底。
    const onSessionEvent = (session, event) => {
      try {
        const sid = session?.id ?? session?.sessionId;
        if (sid !== childId || !event) return;
        entry.stream.diag.live += 1;
        ingest(event);
      } catch { /* 实时通道异常不影响主流程 */ }
    };
    try {
      this.ctx.on?.('session/event', onSessionEvent);
      entry.streamOff = () => { try { this.ctx.off?.('session/event', onSessionEvent); } catch { /* best effort */ } };
    } catch { /* 无事件能力的环境：退化为轮询 */ }

    const tick = async () => {
      if (entry.streamStopped) return; // 已在 done 后补采过一次
      let events = null;
      const method = chain[idx];
      try {
        if (method === 'readSession') events = (await sq.readSession(childId))?.events;
        else if (method === 'readSurface') events = (await sq.readSurface(childId))?.events;
        else events = await sq.listEvents(childId);
      } catch (error) {
        dbg('assistStream: 读取失败，尝试下一数据源', { requestId: entry.id, method, error: String(error?.message || error) });
        entry.stream.diag.errors = [...(entry.stream.diag.errors || []), `${method}: ${String(error?.message || error)}`];
        idx += 1;
        if (idx >= chain.length) {
          entry.streamError = String(error?.message || error);
          return; // 全部数据源都失败：停用采集（只保留阶段行）
        }
        entry.stream.diag.source = chain[idx];
        entry.streamTimer = setTimeout(tick, 0); // 切源后立即重试（候选链有限，不会无限循环）
        return;
      }
      if (Array.isArray(events)) for (const ev of events) ingest(ev);
      // 轮询降为兜底（实时通道为主）：2s 一次，补齐实时可能漏掉的事件
      if (!entry.done) entry.streamTimer = setTimeout(tick, 2000);
    };
    // done 后的补采入口：跑最后一次再标记停止（保证拿到最后一帧 chunk）
    entry.finalTick = async () => {
      if (entry.streamStopped) return;
      entry.streamStopped = true;
      await tick();
    };
    // 立即采一次（首帧信息尽快可见），之后由实时事件为主、2s 轮询兜底
    void tick();
  }

  /** 从事件里按扁平/嵌套形状取字段（事件体可能是 ev.x / ev.payload.x / ev.data.x）。 */
  _evField(ev, key) {
    if (!ev || typeof ev !== 'object') return undefined;
    if (ev[key] !== undefined) return ev[key];
    if (ev.payload && ev.payload[key] !== undefined) return ev.payload[key];
    if (ev.data && ev.data[key] !== undefined) return ev.data[key];
    return undefined;
  }

  /**
   * 从工具调用参数里增量提取结构化输出的 reply 文本 → 作为"正文流"显示。
   * 背景：assist-script 用 schema 输出，模型不产生普通 text 块，而是调用
   * `structured_output` 工具并逐块生成 `{"reply": "...", "edits": [...]}`；
   * 因此 args 里 reply 字段的增量，正是用户看到的"助手正在写回复"。
   */
  _extractReplyText(stream, tool) {
    if (!stream || !tool || !tool.args) return;
    const name = String(tool.name || '');
    if (!/structured_output|structured-output/i.test(name)) return; // 只认结构化输出通道
    const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(String(tool.args));
    if (!m) return;
    const decoded = this._decodeJsonStringPrefix(m[1]);
    const seen = stream.replySeen || 0;
    if (decoded.length <= seen) return;
    const t = stream.text + decoded.slice(seen);
    stream.text = t.length > 4000 ? t.slice(0, 4000) + '…（已截断）' : t;
    stream.replySeen = decoded.length;
  }

  /** 解码（可能未闭合的）JSON 字符串前缀：尾部不完整转义直接丢弃。 */
  _decodeJsonStringPrefix(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '\\') { out += c; continue; }
      const n = s[i + 1];
      if (n === undefined) break; // 尾部不完整转义
      if (n === 'n') { out += '\n'; i++; }
      else if (n === 't') { out += '\t'; i++; }
      else if (n === 'r') { out += '\r'; i++; }
      else if (n === '"') { out += '"'; i++; }
      else if (n === '\\') { out += '\\'; i++; }
      else if (n === '/') { out += '/'; i++; }
      else if (n === 'u') {
        const hex = s.slice(i + 2, i + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break; // 不完整 \uXXXX
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
      } else { out += n; i++; }
    }
    return out;
  }

  /** 把一条会话事件合并进 stream 快照（形状依据真实日志，见 tools/diag-session-log.mjs）。 */
  _applyAssistEvent(stream, ev) {
    if (!stream || !ev) return;
    const MAX = 4000;
    const clip = (s) => {
      const t = String(s == null ? '' : s);
      return t.length > MAX ? t.slice(0, MAX) + '…（已截断）' : t;
    };
    const type = String(ev.type || '');
    const F = (k) => this._evField(ev, k);

    // 逐块增量：data.chunk 为标准 StreamChunk 判别联合
    if (type === 'assistant/chunk') {
      const c = F('chunk') || {};
      if (c.type === 'text-delta' && c.text) stream.text = clip(stream.text + c.text);
      else if (c.type === 'reasoning-delta' && c.text) stream.reasoning = clip(stream.reasoning + c.text);
      else if (c.type === 'tool-call-delta') {
        const last = stream.tools[stream.tools.length - 1];
        if (last && last.status === 'pending' && (!c.id || last.id === c.id)) {
          if (c.name) last.name = c.name;
          if (c.argumentsDelta) last.args = clip(String(last.args || '') + c.argumentsDelta);
          this._extractReplyText(stream, last);
        } else {
          const t = { id: c.id || null, name: c.name || '（工具）', args: clip(c.argumentsDelta || ''), result: null, status: 'pending' };
          stream.tools.push(t);
          this._extractReplyText(stream, t);
        }
      }
      return;
    }

    // 批量压缩增量（宿主把多片聚合成一条，附 dt 差分）：data.texts 为推理分片数组
    if (type === 'reasoning-chunks' || type === 'text-chunks') {
      const parts = Array.isArray(F('texts')) ? F('texts') : [];
      if (parts.length) {
        const merged = parts.join('');
        if (type === 'reasoning-chunks') stream.reasoning = clip(stream.reasoning + merged);
        else stream.text = clip(stream.text + merged);
      }
      return;
    }

    // 批量压缩增量：工具调用（data.name + data.args 分片数组 + data.id）
    if (type === 'tool-call-chunks') {
      const id = F('id') || null;
      const name = F('name') || '（工具）';
      const argsParts = Array.isArray(F('args')) ? F('args') : [];
      const last = stream.tools[stream.tools.length - 1];
      let t;
      if (last && last.status === 'pending' && (!id || last.id === id || last.id === null)) {
        last.id = last.id || id;
        last.name = name;
        last.args = clip(String(last.args || '') + argsParts.join(''));
        t = last;
      } else {
        t = { id, name, args: clip(argsParts.join('')), result: null, status: 'pending' };
        stream.tools.push(t);
      }
      this._extractReplyText(stream, t);
      return;
    }

    if (type === 'tool/call') {
      const name = F('name') || F('tool') || '（工具）';
      const argsRaw = F('arguments');
      // 真实日志里 arguments 已是 JSON 字符串；对象则序列化
      const args = argsRaw === undefined ? '' : (typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw));
      const callId = F('callId') || F('id') || F('toolCallId') || null;
      const last = stream.tools[stream.tools.length - 1];
      if (last && last.status === 'pending' && (!callId || last.id === callId || last.id === null)) {
        last.id = last.id || callId;
        last.name = name;
        if (args) last.args = clip(args);
      } else {
        stream.tools.push({ id: callId, name, args: clip(args), result: null, status: 'pending' });
      }
      return;
    }

    if (type === 'tool/result') {
      // 真实形状：data.message.content[0].content[0].text（嵌套工具结果块）
      const msg = F('message');
      let text = '';
      let isError = false;
      const blocks = msg && Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        if (b?.isError) isError = true;
        if (b?.toolCallId) F('toolCallId');
        const inner = Array.isArray(b?.content) ? b.content : [];
        for (const x of inner) {
          if (typeof x === 'string') text += x;
          else if (x?.text) text += x.text;
        }
      }
      if (!text) {
        const c = F('content') ?? F('result') ?? F('output');
        if (c !== undefined) text = typeof c === 'string' ? c : JSON.stringify(c);
      }
      const resId = blocks.find((b) => b?.toolCallId)?.toolCallId || F('callId') || F('id') || null;
      const target = [...stream.tools].reverse().find((t) => t.status === 'pending' && (!resId || t.id === resId || t.id === null));
      const ok = F('ok');
      const status = (ok === false || isError) ? 'error' : 'done';
      if (target) {
        target.status = status;
        target.result = clip(text);
        if (!target.id) target.id = resId;
      } else {
        stream.tools.push({ id: resId, name: F('name') || '（工具）', args: '', result: clip(text), status });
      }
      return;
    }

    if (type === 'assistant/message') {
      // 折叠后的完整消息：text / reasoning 块 + usage。
      // 有 seq 时按游标累积（多 step 都能进）；无 seq（部分表层事件）时幂等填充，避免重复翻倍。
      const msg = F('message');
      const usage = (msg && msg.usage) || F('usage');
      if (usage) stream.usage = usage;
      const hasCursor = Number.isFinite(Number(ev.seq ?? ev.seq0 ?? ev.time0 ?? ev.time));
      let text = '';
      let reasoning = '';
      if (msg && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && block.text) text += block.text;
          else if ((block.type === 'reasoning' || block.type === 'thinking') && (block.text || block.reasoning)) {
            reasoning += (block.text || block.reasoning);
          }
        }
      } else if (typeof msg?.content === 'string') {
        text += msg.content;
      }
      if (hasCursor) {
        if (text) stream.text = clip(stream.text + text);
        if (reasoning) stream.reasoning = clip(stream.reasoning + reasoning);
      } else {
        if (text && !stream.text) stream.text = clip(text);
        if (reasoning && !stream.reasoning) stream.reasoning = clip(reasoning);
      }
      return;
    }

    if (type === 'turn/start' || type === 'turn/end' || type === 'step/start' || type === 'step/end') {
      stream.lastBoundary = type;
    }
  }

  /** 读取某轮对话的过程（seq 增量）、实时流快照与最终结果；未知 id 返回 null。 */
  assistProgress(requestId, since = 0) {
    const entry = this.assistRuns.get(requestId);
    if (!entry) return null;
    const n = Number(since) || 0;
    return {
      events: entry.events.filter((e) => e.seq > n),
      ...(entry.stream ? { stream: entry.stream } : {}),
      done: entry.done,
      ...(entry.done && entry.result ? { result: entry.result } : {}),
      ...(entry.done && entry.error ? { error: entry.error } : {}),
    };
  }

  /** registry 回收：保留最近 20 条 / 2 小时内的记录，避免长跑内存增长。 */
  _pruneAssistRuns() {
    const now = Date.now();
    for (const [id, e] of this.assistRuns) {
      if (e.done && now - (e.finishedAt || e.createdAt) > 2 * 60 * 60 * 1000) this.assistRuns.delete(id);
    }
    while (this.assistRuns.size > 20) {
      const oldest = [...this.assistRuns.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (!oldest) break;
      this.assistRuns.delete(oldest[0]);
    }
  }

  /** 启动一个任务的工作流（resumeFrom / rerunStage 可选） */
  async startTask(task, opts = {}) {
    // 并发守卫：检查 + 同步占位必须在任何 await 之前原子完成，堵住 TOCTOU 竞态——
    // 否则两个并发请求会双双通过守卫、启动两份 subagent（双倍 LLM 成本 + 互踩 stage）。
    if (this.runs.has(task.id)) {
      dbg('startTask: 并发守卫命中（runs 已有条目）', { taskId: task.id, optsKeys: Object.keys(opts) });
      throw new RunAlreadyActiveError(`任务 ${task.id} 已有运行中的 run，请先等待完成或取消后再启动`);
    }
    const pendingMarker = {};
    this.runs.set(task.id, pendingMarker);
    dbg('startTask: 占位已登记', { taskId: task.id, optsKeys: Object.keys(opts) });
    try {
    // 任务快照优先：运行只用创建时的快照，与工作流后续修改解耦
    const workflow = task.workflowSnapshot || await this.store.getWorkflow(task.workflowId);
    if (!workflow) throw new Error(`workflow not found: ${task.workflowId}`);
    // 回写快照：调度器路径刻意不预存快照（触发时用最新定义），但 UI 的任务详情/运行效果图/
    // 人工审批卡全都依赖 task.workflowSnapshot 渲染——不回写就会出现「详情无流程图」，
    // 且到人工节点时 humanRoutes(undefined) 抛错导致详情整页空白。
    // 语义不变：写回的就是本次触发时解析到的定义（下方 saveTask 一并落盘）。
    if (!task.workflowSnapshot) task.workflowSnapshot = workflow;

    // 为每个任务动态创建一个专用顶层会话作为 parent（隔离用户现有会话，
    // 不让 workflow 的 subagent 挂在「随机」的当前会话下）；失败则回退现有会话。
    // seed（可继承配置的现有会话）不是必需的：任务自带 cwd 时，即使宿主里没有
    // 任何活跃会话（刚启动 dsh web 直接在插件面板建任务：HTTP 链路无 initiator、
    // roots 为空）也能自建专用 parent；无 seed 时 preset 用默认、模型用任务配置
    // 或宿主默认。
    const agents = this.ctx.get('agents');
    let parent = null;
    let parentHandle = null;
    const seed = agents?.currentInitiator?.() ?? agents?.roots?.()?.[0] ?? null;
    // 关键：专用 parent 必须带 cwd（工作目录），否则它的 subagent 继承不到 cwd，
    // 会以「no working directory for the child」启动即失败（task 被误标 success）。
    // 优先用任务 cwd，其次继承 seed 会话的 cwd；两者皆无且无 seed 时不创建，
    // 走下面的可操作报错（选个工作目录 / 先打开一个会话）。
    const parentCwd = task.cwd || seed?.session?.header?.cwd || null;
    if (typeof agents?.create === 'function' && (seed || parentCwd)) {
      try {
        // 关键：专用 parent 必须挂 agent preset（与宿主 apiproxy 的 composeAgent 同构）。
        // agents.create 出来的新 agent scope 没有 parent：不挂 preset 时它——以及经
        // composeFrom 继承其组合的全部 workflow subagent——只能看到宿主全局层，
        // skill 工具与 catalog（含 ~/.dsh/skills 用户级 skills）、write/bash/pwsh 等
        // preset 层工具全部缺失（subagent 只能瞎猜 write_file/shell 之类幻觉工具名）。
        // preset id 必须在创建会话之前 resolve：header 在 session 边界快照 meta 时
        // 定型，setup 里才发现的 id 永远进不了 header。挂载本身放在 setup 里，
        // 失败会回滚整个创建（外层 catch 回退到现有会话，其 preset 天然可用）。
        // 无 seed 时 resolve(undefined) 回落到默认 preset，与 apiproxy 行为一致。
        const presets = this.ctx.get('agentPresets');
        const presetId = presets
          ? (await presets.resolve(seed?.session?.header?.agentPreset))?.id
          : undefined;
        parentHandle = await agents.create({
          sessionId: `knj-task-${task.id}-${randomUUID().slice(0, 8)}`,
          agentOptions: {
            // 任务级模型配置优先（新建任务表单指定，如当前会话模型额度不足换其他模型）；
            // 未配置则继承发起会话（seed）的模型；无 seed 时省略 → 宿主默认模型。
            ...((task.model || seed?.options?.model) != null ? { model: task.model || seed?.options?.model } : {}),
            ...((task.provider || seed?.options?.provider) != null ? { provider: task.provider || seed?.options?.provider } : {}),
            ...(seed?.options?.maxTokens != null ? { maxTokens: seed.options.maxTokens } : {}),
          },
          meta: {
            ...(parentCwd ? { cwd: parentCwd } : {}),
            ...(presetId ? { agentPreset: presetId } : {}),
          },
          ...(presets ? {
            setup: async (agentCtx) => {
              await presets.mount(agentCtx, presetId);
            },
          } : {}),
        });
        parent = parentHandle?.agent;
      } catch (error) {
        this.ctx.logger?.warn?.(`dsh-knj-workflow: 创建专用 parent 会话失败，回退现有会话: ${error?.message || error}`);
      }
    }
    if (!parent) parent = agents?.currentInitiator?.() ?? agents?.roots?.()?.[0];
    if (!parent) {
      // 到这里说明：宿主没有任何活跃会话（currentInitiator/roots 皆空），且上面没能
      // 自建专用 parent。给出能直接照做的提示，而不是让人摸不着头脑的内部错误。
      if (typeof agents?.create !== 'function') {
        throw new Error('no active agent to own the workflow run（agents.create 不可用：需加载 agent-loop 插件）');
      }
      if (!parentCwd) {
        throw new Error('无法确定任务工作目录：当前没有活跃会话可继承。请在「新建任务」表单中选择工作目录，或先打开任意一个会话再启动任务');
      }
      throw new Error('no active agent to own the workflow run（专用 parent 会话创建失败，详见宿主日志；也可先打开一个会话再试）');
    }

    // 文件入参：把暂存文件物化进工作区，并把绝对路径写进 task.inputs（与需求落盘一样放启动前）
    await materializeFileInputs(this.uploads, task);
    // 内置通用附件（无需声明）：同样在启动前物化，并写进 inputs.附件（换行拼接绝对路径）
    await materializeAttachments(this.uploads, task);
    // 路径型文件入参：解析成绝对路径并校验存在（路径引用在触发时读当时的文件）
    await resolveAndVerifyFileInputs(task, workflow);
    // 超阈值需求：在**启动前**落盘（单点 owner，覆盖路由/调度器/命令/续跑全部入口）——
    // 落在这里才能保证「有 run 就一定有可读的完整需求文件」；下一行的 saveTask 把
    // descriptionFile 一并持久化。
    await spillRequirementBeforeRun(this.store, task, this.ctx);
    // 记录 parent 会话 id（agent.id === session.id，见 agent-loop enter 校验），
    // 前端「执行记录」用它 refreshSubagents 并把每个节点 subagent 跳转回原生会话。
    task.parentSessionId = parent.id;
    await this.store.saveTask(task);

    // workflowEngine 是 agent-scope 服务（dsh-scope），必须在 agent 的 scope 上下文内解析。
    // Agent 暴露 scope（Scope 对象，.ctx 是带标签的上下文）；loopCtx 是 agent loop 的上下文。
    // engine 解析或 engine.start 抛错时，必须释放已创建的专用 parent，否则成为泄漏的常驻 agent。
    let run;
    try {
      const scopeCtx = parent.scope?.ctx ?? parent.loopCtx;
      const engine = scopeCtx?.get?.('workflowEngine');
      if (!engine) {
        throw new Error('workflowEngine unavailable in the owning agent scope (is an agent preset with workflow support mounted?)');
      }
      const taskDir = join(this.store.tasksDir, task.id);
      // 需求注入在 Host 侧算好一次：编排器脚本跑在 workflow 引擎沙箱里（无 require/import，
      // 见 lib/orchestrator.js 头部注释），无法复用 lib/requirement.js —— 若在脚本里再实现
      // 一份阈值逻辑必然漂移。超阈值时只传「头部摘录 + 文件指针」，不传全文（控 prompt 体积）。
      const injectedDescription = formatInputDescription(task);
      const inlineDescription = countChars(task.description) <= INLINE_MAX ? injectedDescription : '';
      run = engine.start({
        script: this.orchestratorScript || readFileSync(new URL('./orchestrator.js', import.meta.url), 'utf8'),
        meta: { name: workflow.id, description: `${task.title} @ ${workflow.name}` },
        args: {
          config: workflow,
          task: {
            id: task.id, title: task.title, taskDir,
            ...(injectedDescription ? { inputDescription: injectedDescription } : {}),
            ...(inlineDescription ? { description: inlineDescription } : {}),
            ...(task.storyCode ? { storyCode: task.storyCode } : {}),
            ...(task.cwd ? { cwd: task.cwd } : {}),
          },
          ...(task.inputs && typeof task.inputs === 'object' ? { inputs: task.inputs } : {}),
          ...(opts.decision ? { decision: opts.decision } : {}),
          ...(opts.initialResults ? { initialResults: opts.initialResults } : {}),
          ...(opts.decided ? { decided: opts.decided } : {}),
          ...(opts.resumeFrom ? { resumeFrom: opts.resumeFrom } : {}),
          ...(opts.rerunStage ? { rerunStage: opts.rerunStage } : {}),
        },
        parent,
      });
    } catch (error) {
      if (parentHandle) { try { await parentHandle.dispose?.(); } catch {} }
      throw error;
    }

    this.listeners.set(task.id, run.id);
    this.runs.set(task.id, run);
    dbg('startTask: run 已登记', { taskId: task.id, runId: run.id });
    if (parentHandle) this.parentHandles.set(run.id, parentHandle);
    this.monitorRun(task, run);
    return { runId: run.id };
    } catch (error) {
      // 早期失败（workflow 缺失 / 无 parent / 引擎不可用 / engine.start 抛错）：
      // 清除占位标记，让任务可再次启动。真实 run 已登记时（成功路径）不会走到这里。
      if (this.runs.get(task.id) === pendingMarker) this.runs.delete(task.id);
      dbg('startTask: 启动失败（已清理占位）', { taskId: task.id, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /** 监听 run 事件并回写任务状态（事件签名：(info, payload)） */
  async monitorRun(task, run) {
    dbg('monitorRun: 注册监听', { taskId: task.id, runId: run.id });
    const ctx = this.ctx;
    const matches = (info) => info?.id === run.id;

    const onPhase = (info, title) => {
      if (!matches(info)) return;
      this.store.mutateTask(task.id, (t) => {
        const now = nowIso();
        // phase 现在是 node id（编排器 phase(node.id)），按 s.id 匹配，重名节点不串标
        const matched = (t.stageStates || []).find((x) => x.id === title);
        if (matched) t.currentStage = matched.title;
        t.stageStates = (t.stageStates || []).map((s) => {
          // skipped/failed 也要重新标 running：resume 重跑时旧状态会挡住进度推进
          if (s.id === title && (s.status === 'pending' || s.status === 'skipped')) return { ...s, status: 'running', startedAt: s.startedAt || now };
          return s;
        });
      }).catch(() => {});
    };
    const onAgentStart = (info, agent) => {
      if (!matches(info)) return;
      this.store.mutateTask(task.id, (t) => {
        const title = agent?.phase || agent?.label;
        const childId = agent?.childId;
        // 关联节点 subagent 会话 id；只记节点主体/并行分片（label 不含 ':'），
        // prehook 动作代理（label=node:xxx）不污染 sessionIds。
        const isNodeAgent = agent?.label && !String(agent.label).includes(':');
        if (title && childId && isNodeAgent) {
          const s = (t.stageStates || []).find((x) => x.id === title);
          if (s) {
            // 去重追加：resume/重跑会让同一节点再次产生 agent-start 事件，无脑 append 会让
            // sessionIds 无限增长（每次续跑 +N 条重复 id）
            const ids = s.sessionIds || [];
            if (!ids.includes(childId)) s.sessionIds = [...ids, childId];
            // 真实执行信号：主体 subagent 启动 = 本节点正在跑。多轮复用同一节点时
            // （如人工驳回 → fix 重做 → 再驳回 → fix 再重做），上一轮 done 会挡死状态：
            // onPhase 只把 pending/skipped→running，onAgentEnd 只把 running→done，
            // done 阶段被再次执行时永远停留在旧 done/旧 finishedAt（task-mtu18nd3 实测：
            // 显示 fix 已完成 12:06，实际 checkpoint 12:31 才落盘）。这里以 agent-start
            // 为唯一事实源强制置回 running：清 finishedAt、刷新 startedAt 为本轮纪元。
            if (s.status !== 'running') {
              s.status = 'running';
              s.startedAt = nowIso();
              s.finishedAt = undefined;
              s.error = undefined;
            }
          }
        }
      }).catch(() => {});
    };
    const onAgentEnd = (info, agent) => {
      if (!matches(info)) return;
      this.store.mutateTask(task.id, (t) => {
        const title = agent?.phase || agent?.label;
        // 只对「主体 subagent」（label 不含 ':' 且不含 '#'）标 done：
        // prehook（label=node:xxx）完成不代表节点完成；并行分片（label=node #N）逐个结束
        // 也不能提前标 done（等全部结束由 finalizeTask 用 stageLog 标）。
        const isMain = agent?.label && !String(agent.label).includes(':') && !String(agent.label).includes('#');
        if (title && isMain) {
          const s = (t.stageStates || []).find((x) => x.id === title);
          if (s && s.status === 'running') { s.status = 'done'; s.finishedAt = nowIso(); }
        }
      }).catch(() => {});
    };
    // 编排器每完成一个节点会 log 一条 `[knj-checkpoint]`（JSON: {node, output}），
    // Host 落盘到 stages/<nodeId>.json —— 这是取消/中断后断点续跑的数据源
    // （不依赖 subagent 写文件，实测 subagent 常不遵守写文件指令）。
    const onLog = (info, message) => {
      if (!matches(info) || typeof message !== 'string') return;
      if (!message.startsWith('[knj-checkpoint]')) return;
      try {
        const data = JSON.parse(message.slice('[knj-checkpoint]'.length));
        if (data && data.node && data.output !== undefined) {
          this.store.writeStage(task.id, String(data.node), data.output).catch(() => {});
        }
      } catch {}
    };
    ctx.on('workflow/phase', onPhase);
    ctx.on('workflow/agent-start', onAgentStart);
    ctx.on('workflow/agent-end', onAgentEnd);
    ctx.on('workflow/log', onLog);

    // 唯一终态来源：run.result（含完整 value.results）。
    // 注意 workflow/end 事件 payload 只有 stopReason/error/agentsStarted、不含 value，
    // 不能拿它 finalizeTask，否则会用空 results 覆盖正确结果（已踩坑）。
    // run.result 契约上永不 reject，直接 await 设置终态 + 清理监听器。
    run.result.then(async (result) => {
      dbg('monitorRun: result 落定', {
        taskId: task.id, runId: run.id,
        stopReason: result?.stopReason,
        paused: !!(result?.value && result.value.paused),
        runsIsRun: this.runs.get(task.id) === run,
        runsHas: this.runs.has(task.id),
        valueKeys: result?.value ? Object.keys(result.value) : [],
      });
      try {
        // 只允许「当前活跃 run」写终态：cancel→resume 时旧 run 的 result 晚到，
        // 若不校验会覆盖新 run 状态；parent 按 runId 管理，旧 run 只 dispose 自己的 parent，
        // 不会误杀新 run 的子代理（dsh-subagent dispose 会级联 cancel({kind:'parent'})）。
        if (this.runs.get(task.id) === run) {
          await this.finalizeTask(task.id, result);
        }
      } catch {}
      // 清理放 finally 语义（即使 finalizeTask 抛错也必须 off 监听器 + dispose parent）
      // 注意：ctx.off 在真实环境可能抛错（监听器已随 ctx 生命周期注销等），必须各自独立 try——
      // 若 ctx.off 抛错冒泡到外层 .catch，后面的 runs.delete 永不执行 → runs 残留 →
      // decide/resume 全部被并发守卫 409 卡死（人工节点无法继续，实测复现）。
      try { ctx.off('workflow/phase', onPhase); } catch {}
      try { ctx.off('workflow/agent-start', onAgentStart); } catch {}
      try { ctx.off('workflow/agent-end', onAgentEnd); } catch {}
      try { ctx.off('workflow/log', onLog); } catch {}
      if (this.runs.get(task.id) === run) {
        this.listeners.delete(task.id);
        this.runs.delete(task.id);
        dbg('monitorRun: runs 已清理', { taskId: task.id, runId: run.id });
      } else {
        dbg('monitorRun: runs 清理被跳过（runs 已被替换/删除）', { taskId: task.id, runId: run.id, runsHas: this.runs.has(task.id) });
      }
      // 关键：run 是 holder-owned，契约要求持有者在 result 落定后调用 run.dispose()
      // 释放引擎侧资源（等待子清理收敛）。不调用的话引擎 run 持续占用 parent 的
      // machine，下面的 parentHandle.dispose() 会挂在 machine.whenIdle() 上永不返回，
      // detachAgent（注册表注销）永远执行不到——实测复现：每个成功任务都遗留一个
      // 常驻 knj-task-* root agent。与 dsh-tool-workflow 的规范持有方式
      // （finally { await run.dispose() }）对齐。dispose 失败不阻塞终态，记 warn 可观测。
      try {
        await run.dispose?.();
      } catch (error) {
        this.ctx.logger?.warn?.(`dsh-knj-workflow: run dispose 失败（parent 可能泄漏）: ${error?.message || error}`);
      }
      // 终态后释放专用 parent 会话（按 runId，避免误删新 run 的 parent）
      const handle = this.parentHandles.get(run.id);
      if (handle) {
        this.parentHandles.delete(run.id);
        try { await handle.dispose?.(); } catch (e) { /* 忽略 dispose 失败，任务已终态 */ }
      }
    }).catch((error) => {
      dbg('monitorRun: result.then 回调异常（清理可能被跳过 → runs 残留）', { taskId: task.id, error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** 取消后台 run（真正停止，否则 finalizeTask 会把 cancelled 覆盖成 success/failed） */
  cancelTask(taskId) {
    const run = this.runs.get(taskId);
    dbg('cancelTask: 调用', { taskId, hasRun: !!run, isMarker: run !== undefined && run !== null && typeof run !== 'object' ? false : (!!run && typeof run.cancel !== 'function') });
    if (run && typeof run.cancel === 'function') run.cancel();
  }

  /** 取消该桥上全部活跃 run（插件卸载清理：subagent 群不得在插件消失后继续烧 LLM 成本） */
  cancelAll() {
    for (const taskId of [...this.runs.keys()]) this.cancelTask(taskId);
  }

  /** 根据 run 结果设置任务终态（幂等） */
  async finalizeTask(taskId, result) {
    // 任务已被删除（DELETE 路由取消后立即删目录）时，旧 run 落定不应重建 results.json 孤儿目录
    if (!(await this.store.getTask(taskId))) return;
    const value = result?.value;
    // 人工节点暂停：标记 waiting-human + 落盘断点（result.value 是编排器 return 值）
    if (value?.paused) {
      dbg('finalizeTask: paused 分支（人工暂停）', { taskId, pausedAt: value.pausedAt });
      const m1 = await this.store.mutateTask(taskId, (t) => {
        t.status = 'waiting-human';
        t.currentStage = value.pausedAt;
        t.humanState = { humanId: value.pausedAt, results: value.results || {} };
      });
      dbg('finalizeTask: paused mutateTask 完成', { taskId, m1Status: m1?.status });
      await this.store.saveResults(taskId, value.results || {});
      dbg('finalizeTask: paused saveResults 完成', { taskId });
      return;
    }
    const stopReason = result?.stopReason;
    const failMsg = stopReason === 'completed' ? null : (result?.error ?? stopReason ?? 'unknown');
    // 终态修正：用编排器 stageLog 标记实际执行过的节点，没执行的 pending 标为 skipped
    // （XOR 分叉没走的分支、并行未触及的节点），避免进度条永远到不了 100%。
    const executedIds = new Set((value?.stageLog || []).map((e) => e.id));
    await this.store.mutateTask(taskId, (t) => {
      if (stopReason === 'completed') {
        t.status = 'success';
      } else if (stopReason === 'cancelled') {
        t.status = 'cancelled';
      } else {
        t.status = 'failed';
        t.error = result?.error ?? stopReason ?? 'unknown';
      }
      t.finishedAt = nowIso();
      t.stageStates = (t.stageStates || []).map((s) => {
        if (s.status === 'running') {
          // cancelled 时 running 标 done（用户主动取消，节点不是失败，避免误导）
          const failed = stopReason !== 'completed' && stopReason !== 'cancelled';
          return { ...s, status: failed ? 'failed' : 'done', finishedAt: nowIso(), ...(failed && failMsg ? { error: failMsg } : {}) };
        }
        if (s.status === 'pending' && !executedIds.has(s.id)) return { ...s, status: 'skipped' };
        return s;
      });
    });
    await this.store.saveResults(taskId, result?.value?.results || {});
  }
}

// ---------------------------------------------------------------------------
// HTTP API 路由
// ---------------------------------------------------------------------------
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}
/**
 * 文件入参：把暂存的上传物化到任务工作区，并把**绝对路径**写进 `task.inputs[param]`。
 *
 * 目标位置 `<cwd>/.knj-inputs/<taskId>/<文件名>`，选工作区而不是 ~/.dsh 的原因：
 * 节点本来就在工作区内作业（读文件/跑命令），侧栏预览也受 workspace 边界约束——放工作区
 * 两侧都无需放宽。目录内写一份 `*` 的 .gitignore，上传文件默认不进用户的版本库。
 *
 * 放在 startTask（单点 owner）：创建入口有多条（表单 / 调度器 / 命令 / 续跑），且 `cwd`
 * 只在这里才解析得到。物化失败必须**拒绝启动**——文件入参指向空比启动失败更糟。
 */
/**
 * 路径型文件入参：启动前把相对路径按任务 `cwd` 解析成**绝对路径**，并校验文件确实存在。
 *
 * 与上传物化放在同一个入口（startTask）：两种来源（表单上传 / 路径引用，后者主要给定时任务用）
 * 在启动前都必须落到"存在且明确"——节点拿到的必须是一个可读的绝对路径，否则拒绝启动。
 * 路径引用的语义正是"触发时读当时的文件"（不复制、不缓存），所以存在性只能在启动时校验。
 */
async function resolveAndVerifyFileInputs(task, workflow) {
  const declared = declaredFileInputs(workflow);
  if (declared.length === 0) return;
  const inputs = { ...(task.inputs && typeof task.inputs === 'object' ? task.inputs : {}) };
  for (const inp of declared) {
    const raw = inputs[inp.name];
    if (typeof raw !== 'string' || !raw.trim()) {
      if (inp.required) {
        throw new Error(`缺少必填文件入参 ${inp.name}：请在新建任务时选择文件，或为该参数提供路径（定时任务请在调度里填写）`);
      }
      continue;
    }
    const value = raw.trim();
    const resolved = isAbsolute(value) ? value : resolve(task.cwd || '', value);
    let info = null;
    try { info = await stat(resolved); } catch { /* 不存在：下面统一报可操作错误 */ }
    if (!info || !info.isFile()) {
      throw new Error(`文件入参 ${inp.name} 指向的文件不存在：${resolved}（相对路径按任务工作目录解析；定时任务请在触发前确保该文件已生成）`);
    }
    inputs[inp.name] = resolved;
  }
  task.inputs = inputs;
}

async function materializeFileInputs(uploads, task) {
  const pending = task.pendingFileInputs;
  if (!pending || typeof pending !== 'object' || Object.keys(pending).length === 0) return;
  if (!uploads) throw new Error('文件入参需要上传服务，但当前上下文没有 uploads（请重启 dsh web 后重试）');
  if (!task.cwd) throw new Error('文件入参需要任务工作目录（cwd），当前为空：请在新建任务时选择工作目录');

  const dir = join(task.cwd, WORKSPACE_INPUT_DIR, task.id);
  await mkdir(dir, { recursive: true });
  const gitignore = join(task.cwd, WORKSPACE_INPUT_DIR, '.gitignore');
  if (!existsSync(gitignore)) {
    await writeFile(gitignore, '*\n', 'utf8').catch(() => {});
  }

  const inputs = { ...(task.inputs && typeof task.inputs === 'object' ? task.inputs : {}) };
  for (const [param, ref] of Object.entries(pending)) {
    const staged = await uploads.resolve(ref && ref.uploadId);
    if (!staged) {
      throw new Error(`文件入参 ${param} 的上传已失效（暂存被清理或未上传成功）：请重新选择文件后再启动`);
    }
    let dest = join(dir, staged.name);
    if (existsSync(dest)) {
      // 同名冲突（两个参数传了同名文件）：加参数名前缀，保证互不覆盖
      const prefix = sanitizeFileName(param) || 'input';
      dest = join(dir, `${prefix}-${staged.name}`);
    }
    // copy + 清理暂存，而不是 rename：暂存在 ~/.dsh（常在 C:），工作区可能在别的盘，
    // 跨盘 rename 在 Windows 上会 EXDEV 失败。
    await copyFile(staged.path, dest);
    await uploads.discard(staged.uploadId);
    inputs[param] = dest;
  }
  task.inputs = inputs;
  delete task.pendingFileInputs;
}

/**
 * 启动前把超阈值需求全文落盘到 `<tasksDir>/<taskId>/requirement.md`，并把路径记进 `task.descriptionFile`。
 *
 * 为什么放在 startTask（单点 owner）：创建入口有多条——HTTP 路由、调度器服务
 * （`createAndStartScheduledTask` 直接构造 task，**不走路由**）、`/dev-task` 命令、resume/rerun——
 * 它们最终都会经过这里。落盘原先写在路由里，结果调度器路径的长需求不落盘、注入退化成
 * 「完整需求未落盘」，长需求对节点等于丢失。放在这里则任何新入口都不会漏。
 *
 * 幂等（resume/rerun 重复调用无副作用）；未超阈值或已有 descriptionFile 时直接返回；
 * 落盘失败只降级（注入退化为仅头部摘录），不阻断启动。
 */
async function spillRequirementBeforeRun(store, task, ctx) {
  const description = normalizeRequirementText(task?.description);
  if (!description || !needsRequirementFile(description)) return;
  if (typeof task.descriptionFile === 'string' && task.descriptionFile) return;
  try {
    const dir = join(store.tasksDir, task.id);
    await mkdir(dir, { recursive: true });
    const file = join(dir, REQUIREMENT_FILE_NAME);
    await writeFile(file, description, 'utf8');
    task.descriptionFile = file;
  } catch (e) {
    ctx?.logger?.warn?.(`需求落盘失败（${task.id}）：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 请求体字节上限（按字节而非 UTF-16 码元计：中文 3 字节/字，码元计数会低估真实体积） */
export const MAX_BODY_BYTES = 1e7;
/**
 * 读取并解析 JSON 请求体。
 *
 * 必须按 Buffer 累积、最后一次性 UTF-8 解码：旧实现 `raw += chunk` 会在每个 TCP 块
 * 各自解码，多字节字符跨块边界即被截成 U+FFFD —— 中文需求描述超过 ~64KB 时必然出现乱码，
 * 而「粘贴大段中文需求」正是本插件的核心场景。
 */
export async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const bail = (err) => {
      if (settled) return;
      settled = true;
      // 不能在这里 req.destroy()：destroy 发生在路由写响应之前，客户端只会看到
      // "socket hang up"（实测：设计好的 413 永远到不了调用方）。改为抽干剩余请求体，
      // 让路由的 catch 把 413 正常写回。
      try { req.resume?.(); } catch { /* 连接已结束 */ }
      reject(err);
    };

    req.on('data', (c) => {
      if (settled) return;
      // 生产路径永远拿到 Buffer（本函数不调 req.setEncoding）；字符串兜底只应对调用方
      // 自行 setEncoding 的情形，跨块的代理对在那条路径上无法复原（TCP 已无字节边界）。
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8');
      bytes += buf.length;
      if (bytes > maxBytes) {
        const err = new Error(`body too large (> ${maxBytes} bytes)`);
        err.status = 413;
        bail(err);
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', (e) => bail(e));
  });
}

// 导出供路由级测试（lib/index.test.js 直接驱动 handler，不依赖 webServer 服务）
export function registerRoutes(ctx, store, bridge, prefix, uploads) {
  const routes = [
    // 健康检查
    ['GET', '/health', async (c) => sendJson(c.res, 200, { ok: true, plugin: 'dsh-knj-workflow', dataRoot: store.root })],
    // 可用模型列表（新建任务下拉用）：不依赖 llm 服务（Host 插件 realm 拿不到），
    // 直接解析 settings.yaml 里真实配置的 provider/model（agent-default-model + llm-pi-ai.providers），
    // 避免内置猜测出无效 provider id（如 deepseek ≠ deepseek-official/deepseek-modlens）导致 subagent 启动失败
    ['GET', '/models', async (c) => {
      const models = [];
      const seen = new Set();
      const push = (provider, model, label) => {
        if (!provider || !model) return;
        const k = provider + '::' + model;
        if (seen.has(k)) return;
        seen.add(k);
        models.push({ provider, model, label: label || `${provider}/${model}` });
      };
      try {
        const candidates = [
          join(store.root, '..', 'settings.yaml'),
          join(homedir(), '.dsh', 'settings.yaml'),
        ];
        for (const p of candidates) {
          let text;
          try { text = await readFile(p, 'utf8'); } catch { continue; }
          let section = null;       // 0 缩进的顶层块名
          let inPiProviders = false;
          let piProvider = null;
          let inModels = false;
          let defProvider = null, defModel = null;
          for (const line of text.split(/\r?\n/)) {
            const indent = (line.match(/^\s*/) || [''])[0].length;
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            if (indent === 0 && t.endsWith(':')) { section = t.slice(0, -1); inPiProviders = false; piProvider = null; inModels = false; continue; }
            if (section === 'agent-default-model' && indent === 2 && t.startsWith('provider:')) { defProvider = t.replace('provider:', '').trim(); continue; }
            if (section === 'agent-default-model' && indent === 2 && t.startsWith('model:')) { defModel = t.replace('model:', '').trim(); continue; }
            if (section === 'llm-pi-ai' && indent === 2 && t === 'providers:') { inPiProviders = true; continue; }
            if (inPiProviders && indent === 4 && t.endsWith(':') && !t.startsWith('-')) { piProvider = t.slice(0, -1); inModels = false; continue; }
            if (piProvider && indent === 6 && t === 'models:') { inModels = true; continue; }
            if (piProvider && inModels && indent === 8 && t.startsWith('- id:')) push(piProvider, t.replace('- id:', '').trim());
            if (piProvider && inModels && indent <= 6) inModels = false;
          }
          // 默认模型（agent-default-model）放最前：这是你当前环境实际可用的通道
          if (defProvider && defModel) push(defProvider, defModel, `${defProvider}/${defModel}（默认）`);
        }
      } catch { /* 配置解析失败 → 空列表，仅显示"继承当前会话" */ }
      sendJson(c.res, 200, { models });
    }],
    // 诊断：运行时可见性（排查 workflowEngine scope 问题）
    ['GET', '/diag', async (c) => {
      const agents = ctx.get('agents');
      const roots = agents?.roots ? agents.roots() : [];
      const diag = {
        ctxKeys: Object.keys(ctx).filter((k) => /workflow|agent|subagent|scope/i.test(k)),
        hasWorkflowEngineGlobal: !!ctx.get('workflowEngine'),
        hasAgentsService: !!agents,
        rootAgentCount: roots.length,
        roots: roots.map((a) => {
          const scopeCtx = a.scope?.ctx ?? a.loopCtx;
          return {
            id: a.id,
            keys: Object.keys(a).filter((k) => /ctx|scope|session|loop/i.test(k)),
            hasScope: !!a.scope,
            scopeKeys: a.scope ? Object.keys(a.scope) : [],
            engineViaScopeCtx: !!scopeCtx?.get?.('workflowEngine'),
            engineViaLoopCtx: !!a.loopCtx?.get?.('workflowEngine'),
            engineViaCtx: !!a.ctx?.get?.('workflowEngine'),
            loopCtxKeys: a.loopCtx ? Object.keys(a.loopCtx).filter((k) => /workflow|agent|subagent|scope/i.test(k)) : [],
          };
        }),
      };
      sendJson(c.res, 200, diag);
    }],
    // 工作流 CRUD
    ['GET', '/workflows', async (c) => sendJson(c.res, 200, { workflows: await store.listWorkflows() })],
    // AI 助手对话配置（异步 + 过程轮询：前端可实时显示"助手在做什么"）
    //   POST /assist          { workflow(当前草稿), message, history? } → 202 { requestId }
    //   GET  /assist/progress ?id=&since=  → { events[], done, result? , error? }
    ['POST', '/assist', async (c) => {
      const body = await readBody(c.req);
      const workflow = body?.workflow;
      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      if (!workflow || typeof workflow !== 'object' || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) {
        return sendJson(c.res, 400, { error: 'workflow 必须是 { nodes, edges } 结构' });
      }
      if (!message) return sendJson(c.res, 400, { error: 'message 不能为空' });
      try {
        const { requestId } = bridge.startAssist({ workflow, message, history: body.history });
        sendJson(c.res, 202, { requestId });
      } catch (error) {
        sendJson(c.res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }],
    ['GET', '/assist/progress', async (c) => {
      const id = c.url.searchParams.get('id');
      const since = Number(c.url.searchParams.get('since') || 0);
      if (!id) return sendJson(c.res, 400, { error: 'id 不能为空' });
      const p = bridge.assistProgress(id, since);
      if (!p) return sendJson(c.res, 404, { error: '未知的对话请求（可能已过期或服务已重启）' });
      sendJson(c.res, 200, p);
    }],
    ['POST', '/workflows', async (c) => {
      const body = await readBody(c.req);
      const wf = await store.saveWorkflow(body);
      sendJson(c.res, 200, { workflow: wf });
    }],
    ['PUT', '/workflows', async (c) => {
      const body = await readBody(c.req);
      const wf = await store.saveWorkflow(body);
      sendJson(c.res, 200, { workflow: wf });
    }],
    ['DELETE', '/workflows/:id', async (c) => {
      await store.deleteWorkflow(c.params.id);
      sendJson(c.res, 200, { ok: true });
    }],
    // 文件入参的上传暂存（新建任务弹窗「选择文件」用）
    // 表单打开时任务还不存在（没有 taskId / 没有工作区目录），所以先暂存到
    // <dataRoot>/uploads/<uploadId>/，等 startTask 启动前再物化进 <cwd>/.knj-inputs/<taskId>/。
    // 文件名在拼路径前先消毒（本插件栽过一次 id 路径穿越，同类错误不重复）。
    ['POST', '/uploads', async (c) => {
      if (!uploads) return sendJson(c.res, 500, { error: '上传服务不可用（请重启 dsh web 后重试）' });
      const body = await readBody(c.req, UPLOAD_BODY_BYTES);
      try {
        const staged = await uploads.stage({ name: body.name, dataBase64: body.dataBase64 });
        uploads.pruneStale().catch(() => {}); // 顺带清理过期暂存
        sendJson(c.res, 200, staged);
      } catch (e) {
        if (e instanceof UploadError) {
          sendJson(c.res, 400, { error: e.message, code: e.code });
          return;
        }
        throw e;
      }
    }],
    // 任务 CRUD
    ['GET', '/tasks', async (c) => {
      // 归档过滤：?archived=1 → 归档列表；无参/archived=0 → 主列表（不含归档）
      const q = c.url.searchParams.get('archived');
      const archived = q === '1' || q === 'true';
      // ?q= 为 Host 侧全文（含需求正文）过滤——列表项不含 description，客户端无法自行过滤。
      // 无关键词时保持既有入参形状（只传 archived），老调用方与测试不受影响。
      const keyword = c.url.searchParams.get('q') || '';
      sendJson(c.res, 200, { tasks: await store.listTasks(keyword ? { archived, q: keyword } : { archived }) });
    }],
    ['GET', '/tasks/:id', async (c) => {
      const t = await store.getTask(c.params.id);
      if (!t) return sendJson(c.res, 404, { error: 'task not found' });
      // 历史任务兜底：调度器路径创建的任务曾不写 workflowSnapshot，导致详情无流程图、
      // 到人工节点时前端渲染崩溃（空白）。这里用当前定义补齐一个**只读展示用**快照
      // （不落盘、带 fallback 标记，前端据此提示"按当前定义显示"）。
      if (!t.workflowSnapshot && t.workflowId) {
        const wf = await store.getWorkflow(t.workflowId).catch(() => null);
        if (wf) { t.workflowSnapshot = wf; t.workflowSnapshotFallback = true; }
      }
      sendJson(c.res, 200, { task: t });
    }],
    ['POST', '/tasks', async (c) => {
      const body = await readBody(c.req);
      const workflow = body.workflowId ? await store.getWorkflow(body.workflowId) : (await store.listWorkflows())[0];
      if (!workflow) return sendJson(c.res, 400, { error: 'no workflow available' });
      // 需求描述：可选、可长。表单已无标题输入框 —— 未给标题时由描述派生，
      // 描述也为空则用时间戳占位标题（title 恒非空，看板/命令平面依赖它）。
      const description = normalizeRequirementText(body.description);
      const title = (typeof body.title === 'string' && body.title.trim()) || deriveTaskTitle(description);
      const taskId = (typeof body.id === 'string' && body.id) || `task-${Date.now().toString(36)}`;
      // id 必须在**拼任何路径之前**校验：需求落盘用 join(tasksDir, task.id) 写文件，
      // 若把校验留在 saveTask（旧行为）里，穿越 id 会先写出文件再抛错——报错但副作用已发生。
      try {
        DevTaskStore.assertSafeId(taskId);
      } catch {
        return sendJson(c.res, 400, { error: `invalid task id: ${taskId}` });
      }
      // 文件入参：必填校验在这里（创建时就能给出可操作错误）；**物化/路径解析**在 startTask 启动前
      // （那时才有 taskId 对应的目录与解析好的 cwd）。上传（fileInputs）与路径（inputs.<参数名>）
      // 是同一个参数的两种来源，满足其一即可。
      const rawFileInputs = (body.fileInputs && typeof body.fileInputs === 'object' && !Array.isArray(body.fileInputs)) ? body.fileInputs : {};
      const bodyInputs = (body.inputs && typeof body.inputs === 'object' && !Array.isArray(body.inputs)) ? body.inputs : {};
      const missingFiles = declaredFileInputs(workflow)
        .filter((inp) => inp.required)
        .filter((inp) => {
          const ref = rawFileInputs[inp.name];
          const hasUpload = !!ref && typeof ref.uploadId === 'string' && !!ref.uploadId;
          const pathValue = bodyInputs[inp.name];
          const hasPath = typeof pathValue === 'string' && !!pathValue.trim();
          return !hasUpload && !hasPath;
        });
      if (missingFiles.length > 0) {
        return sendJson(c.res, 400, { error: `缺少必填文件入参: ${missingFiles.map((x) => x.name).join(', ')}` });
      }
      const pendingFileInputs = {};
      for (const [param, ref] of Object.entries(rawFileInputs)) {
        if (ref && typeof ref.uploadId === 'string' && ref.uploadId) {
          pendingFileInputs[param] = { uploadId: ref.uploadId, ...(typeof ref.name === 'string' ? { name: ref.name } : {}) };
        }
      }
      // 内置通用附件：**不需要**在工作流里声明（实机上 7 个工作流全零声明，声明式入口等于没有入口）。
      // 只在这里记待物化，物化/写 inputs.附件 统一在 startTask 启动前完成。
      const pendingAttachments = normalizeAttachmentRefs(body.attachments);
      const attachmentsError = describeAttachmentsError(pendingAttachments);
      if (attachmentsError) {
        return sendJson(c.res, 400, { error: attachmentsError });
      }
      const task = {
        id: taskId,
        title,
        workflowId: workflow.id,
        workflowRevision: workflow.revision || 1,
        workflowSnapshot: workflow,
        status: 'pending',
        currentStage: null,
        stageStates: orderTaskNodesByFlow(workflow).map((id) => {
          const n = workflow.nodes.find((x) => x.id === id);
          return { id, title: n?.title || id, status: 'pending' };
        }),
        createdAt: nowIso(),
        ...(body.notes ? { notes: body.notes } : {}),
        // 需求描述必须保存：编排器各节点 prompt 要靠它注入「用户输入的需求内容」
        ...(description ? { description } : {}),
        // 用户故事编码（可选）：节点 prompt 可用 ${storyCode} 引用
        ...(typeof body.storyCode === 'string' && body.storyCode.trim() ? { storyCode: body.storyCode.trim() } : {}),
        ...(body.inputs && typeof body.inputs === 'object' ? { inputs: body.inputs } : {}),
        // 文件入参：此处只记待物化的上传；startTask 启动前把文件写进 <cwd>/.knj-inputs/<taskId>/
        // 并把绝对路径填进 inputs[param]（节点用 ${inputs.<param>} 拿到路径自行解析文档）
        ...(Object.keys(pendingFileInputs).length ? { pendingFileInputs } : {}),
        // 内置通用附件：固定键 inputs.附件，节点 prompt 写 ${inputs.附件} 即可（同样在启动前物化）
        ...(pendingAttachments.length ? { pendingAttachments } : {}),
        ...(body.cwd && typeof body.cwd === 'string' ? { cwd: body.cwd.trim() } : {}),
        // 执行模型：任务级配置优先（新建任务表单可指定，如当前会话模型额度不足时换其他模型）；
        // 未配置时 startTask 继承发起会话的模型。
        ...(body.model && typeof body.model === 'string' ? { model: body.model.trim() } : {}),
        ...(body.provider && typeof body.provider === 'string' ? { provider: body.provider.trim() } : {}),
      };
      // 需求落盘不在这里做：改为 startTask 启动前的单点 owner（spillRequirementBeforeRun），
      // 否则调度器/命令等不走路由的入口会漏掉（见该函数注释）。
      await store.saveTask(task);
      if (body.autoStart !== false) {
        try {
          await bridge.startTask(task);
        } catch (e) {
          if (e instanceof RunAlreadyActiveError) return sendJson(c.res, 409, { error: e.message });
          // 启动失败必须落库为 failed（与 /tasks/:id/start 一致），否则任务永远停在
          // pending，界面只剩一个瞬时 toast，用户不知道可以在修复后点「启动」重试。
          await store.mutateTask(task.id, (tt) => {
            tt.status = 'failed';
            tt.error = `启动失败：${e instanceof Error ? e.message : String(e)}`;
            tt.finishedAt = nowIso();
          }).catch(() => {});
          sendJson(c.res, 500, { error: e instanceof Error ? e.message : String(e) });
          return;
        }
        task.status = 'running';
        task.startedAt = nowIso();
        await store.saveTask(task);
      }
      sendJson(c.res, 200, { task });
    }],
    ['POST', '/tasks/:id/start', async (c) => {
      const t = await store.getTask(c.params.id);
      if (!t) return sendJson(c.res, 404, { error: 'task not found' });
      // 并发/取消中守卫：改状态前先问，避免「取消后立即续跑」窗口把任务误标 failed
      if (bridge.isRunning(c.params.id)) return sendJson(c.res, 409, { error: '任务已有运行中的 run，请稍候再试' });
      t.status = 'running';
      t.startedAt = nowIso();
      await store.saveTask(t);
      try {
        const { runId } = await bridge.startTask(t);
        sendJson(c.res, 200, { task: t, runId });
      } catch (e) {
        if (e instanceof RunAlreadyActiveError) return sendJson(c.res, 409, { error: e.message });
        // 启动失败必须标记 failed，否则任务永久卡 running（取消也无效）
        await store.mutateTask(c.params.id, (tt) => {
          tt.status = 'failed';
          tt.error = `启动失败：${e instanceof Error ? e.message : String(e)}`;
          tt.finishedAt = nowIso();
        }).catch(() => {});
        sendJson(c.res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }],
    ['POST', '/tasks/:id/cancel', async (c) => {
      const t = await store.getTask(c.params.id);
      if (!t) return sendJson(c.res, 404, { error: 'task not found' });
      t.status = 'cancelled';
      t.finishedAt = nowIso();
      await store.saveTask(t);
      bridge.cancelTask(c.params.id); // 真正停止后台 run
      sendJson(c.res, 200, { task: t });
    }],
    ['POST', '/tasks/:id/rerun-stage', async (c) => {
      const body = await readBody(c.req);
      const t = await store.getTask(c.params.id);
      if (!t) return sendJson(c.res, 404, { error: 'task not found' });
      if (!body.stageId) return sendJson(c.res, 400, { error: 'stageId required' });
      if (bridge.isRunning(c.params.id)) return sendJson(c.res, 409, { error: '任务已有运行中的 run，请稍候再试' });
      // 断点恢复：重跑阶段之前的已完成节点结果作为 initialResults（跳过），重跑阶段及之后重新执行
      const steps = t.stageStates || [];
      const idx = steps.findIndex((s) => s.id === body.stageId);
      // 未知 stageId 必须 400：旧行为 idx=-1 → beforeIds=[] → initialResults={} 静默全量重跑
      if (idx === -1) return sendJson(c.res, 400, { error: `stageId not found: ${body.stageId}` });
      const beforeIds = idx > 0 ? steps.slice(0, idx).map((s) => s.id) : [];
      const allResults = await store.readResults(c.params.id) || {};
      const initialResults = {};
      // 之前节点的断点优先用 stage 文件（编排器 checkpoint，取消后仍可靠）；
      // results.json 在取消时是空的，不能作为唯一来源。
      for (const id of beforeIds) {
        const stageData = await store.readStage(c.params.id, id).catch(() => null);
        if (stageData !== null) initialResults[id] = stageData;
        else if (allResults[id] !== undefined) initialResults[id] = allResults[id];
      }
      // 清空重跑节点及之后节点的旧 stage 文件（否则中断后再「续跑」会误用旧 checkpoint，
      // 把本次还没重跑到的节点误判为已完成直接跳过）。
      try {
        const afterIds = new Set(idx >= 0 ? steps.slice(idx).map((s) => s.id) : []);
        const stagesDir = join(store.tasksDir, c.params.id, 'stages');
        if (afterIds.size > 0) {
          const files = await readdir(stagesDir).catch(() => []);
          for (const f of files) {
            const base = f.replace(/\.json$/, '');
            const m = /^(.*)-(\d+)$/.exec(base);
            if (afterIds.has(m ? m[1] : base)) await rm(join(stagesDir, f), { force: true }).catch(() => {});
          }
        }
      } catch {}
      t.status = 'running';
      t.startedAt = nowIso();
      t.currentStage = body.stageId;
      t.stageStates = steps.map((s, i) => {
        if (i < idx) return s; // 之前的保持
        if (i === idx) return { ...s, status: 'running' };
        return { ...s, status: 'pending' }; // 之后的重新执行
      });
      await store.saveTask(t);
      try {
        const { runId } = await bridge.startTask(t, { initialResults });
        sendJson(c.res, 200, { task: t, runId });
      } catch (e) {
        if (e instanceof RunAlreadyActiveError) return sendJson(c.res, 409, { error: e.message });
        await store.mutateTask(c.params.id, (tt) => {
          tt.status = 'failed';
          tt.error = `重跑阶段失败：${e instanceof Error ? e.message : String(e)}`;
          tt.finishedAt = nowIso();
        }).catch(() => {});
        sendJson(c.res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }],
    ['POST', '/tasks/:id/resume', async (c) => {
      const body = await readBody(c.req);
      const mode = body.mode === 'rerun' ? 'rerun' : 'resume';
      const t = await store.getTask(c.params.id);
      if (!t) return sendJson(c.res, 404, { error: 'task not found' });
      // 取消中守卫：cancel 异步落定（最长约 5s），期间 runs 条目仍在——改状态前先问，
      // 避免「取消后立即续跑」被旧守卫误拦后把任务误标 failed（任务永久卡死）。
      if (bridge.isRunning(c.params.id)) {
        dbg('resume: isRunning 预检拦截（runs 仍有条目）', { taskId: c.params.id, mode: body.mode });
        return sendJson(c.res, 409, { error: '任务正在取消/运行中，请稍候再续跑' });
      }
      // 断点来源：续跑（mode=resume）读 stage 文件（每节点完成时编排器 checkpoint 落盘），
      // orchestrator 跳过已完成节点从断点继续；重跑（mode=rerun）清空 initialResults 从头执行。
      // 注意：results.json 在取消时是空的（编排器被中断，中间结果不落盘），不能作为断点来源。
      const initialResults = {};
      if (mode === 'rerun') {
        // 清空旧 stage 文件：否则重跑中途取消后再「续跑」会误用本次重跑前的旧 checkpoint
        try {
          await rm(join(store.tasksDir, c.params.id, 'stages'), { recursive: true, force: true });
        } catch {}
      }
      if (mode === 'resume') {
        try {
          // 识别并行节点（body.mode === 'parallel'）及其分片数，避免 -N 后缀误分类/部分分片被当完整结果
          const parallelPlan = new Map();
          for (const n of (t.workflowSnapshot?.nodes || [])) {
            if (n.type === 'task' && n.body && n.body.mode === 'parallel') {
              parallelPlan.set(n.id, Math.max(1, n.body.parallelItems || 3));
            }
          }
          const stagesDir = join(store.tasksDir, c.params.id, 'stages');
          const files = await readdir(stagesDir);
          const singles = {};
          const parallelParts = {};
          for (const f of files) {
            if (!f.endsWith('.json')) continue;
            const base = f.replace(/\.json$/, '');
            const data = await store.readStage(c.params.id, base);
            if (data === null) continue;
            const m = /^(.*)-(\d+)$/.exec(base); // 并行分片写 node-1.json / node-2.json
            if (m && parallelPlan.has(m[1])) {
              // 只对已知并行节点识别分片，避免「以 -数字 结尾的单节点名」被误分类
              (parallelParts[m[1]] = parallelParts[m[1]] || []).push({ idx: parseInt(m[2], 10), data });
            } else {
              singles[base] = data;
            }
          }
          for (const [k, parts] of Object.entries(parallelParts)) {
            const n = parallelPlan.get(k) || 0;
            parts.sort((a, b) => a.idx - b.idx);
            const complete = n > 0 && parts.length === n && parts.every((p, i) => p.idx === i + 1);
            // 只把「分片完整且序号连续」的并行节点当断点；部分完成让并行节点重跑
            if (complete && !(k in singles)) singles[k] = parts.map((p) => p.data);
          }
          Object.assign(initialResults, singles);
        } catch {}
      }
      const hasInitial = Object.keys(initialResults).length > 0;
      // 重置 stageStates：续跑且有断点（跳过已完成）时保留 done、仅 skipped 重置 pending；
      // 重跑或无断点则全部重置 pending。旧 done/skipped 会挡住 onPhase 重新标记 running，
      // 导致重跑节点进度不更新、任务看似卡住。
      t.stageStates = (t.stageStates || []).map((s) => {
        // skipped/failed 都要重置：failed 节点重跑成功后若不被重置，onPhase 只认 pending/skipped，
        // 节点会永久显示 failed（README 主流程"失败任务可继续"被破坏）。
        if (hasInitial) return (s.status === 'skipped' || s.status === 'failed') ? { ...s, status: 'pending', sessionIds: [], startedAt: undefined, finishedAt: undefined } : s;
        return { ...s, status: 'pending', sessionIds: [], startedAt: undefined, finishedAt: undefined };
      });
      t.status = 'running';
      t.startedAt = nowIso();
      t.error = undefined;
      await store.saveTask(t);
      try {
        // 续跑重走图时重放已审批 human 的最后去向（重跑 rerun 不带——重新决策）
        const decided = mode === 'resume' ? buildDecidedMap(t) : {};
        const { runId } = await bridge.startTask(t, { initialResults, ...(Object.keys(decided).length ? { decided } : {}) });
        sendJson(c.res, 200, { task: t, runId, mode });
      } catch (e) {
        if (e instanceof RunAlreadyActiveError) return sendJson(c.res, 409, { error: e.message });
        await store.mutateTask(c.params.id, (tt) => {
          tt.status = 'failed';
          tt.error = `继续失败：${e instanceof Error ? e.message : String(e)}`;
          tt.finishedAt = nowIso();
        }).catch(() => {});
        sendJson(c.res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }],
    // 人工节点决策：按节点去向（routes 多去向 / 兼容 approve→通过、reject→驳回）
    ['POST', '/tasks/:id/decide', async (c) => {
      const body = await readBody(c.req);
      const t = await store.getTask(c.params.id);
      dbg('decide: 请求进入', {
        taskId: c.params.id, decision: body?.decision, hasFeedback: typeof body?.feedback === 'string' && !!body.feedback.trim(),
        taskStatus: t?.status, hasHumanState: !!(t && t.humanState), humanId: t?.humanState?.humanId,
      });
      if (!t) return sendJson(c.res, 404, { error: 'task not found' });
      if (t.status !== 'waiting-human' || !t.humanState) return sendJson(c.res, 400, { error: 'task not waiting for human' });
      const { humanId, results } = t.humanState;
      const humanNode = (t.workflowSnapshot?.nodes || []).find((n) => n.id === humanId);
      // 去向：routes 优先；兼容旧 approveTo/rejectTo（通过/驳回）
      const routes = (humanNode && Array.isArray(humanNode.routes) && humanNode.routes.length)
        ? humanNode.routes
        : [].concat(humanNode?.approveTo ? [{ label: '通过', to: humanNode.approveTo }] : [], humanNode?.rejectTo ? [{ label: '驳回', to: humanNode.rejectTo }] : []);
      let decision = body.decision;
      if (decision === 'approve') decision = '通过';
      else if (decision === 'reject') decision = '驳回';
      if (!routes.some((r) => r.label === decision)) {
        return sendJson(c.res, 400, { error: `decision 必须是 ${routes.map((r) => r.label).join(' / ') || '未配置去向'}` });
      }
      const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
      // 记录决策历史，便于事后追溯（第几轮审批、结论、意见）
      t.decisions = [...(t.decisions || []), { humanId, decision, feedback, at: nowIso() }];
      // 保存决策前的现场：startTask 若被并发守卫拒绝（RunAlreadyActiveError）必须回滚，
      // 否则 humanState 已清、任务已置 running，用户无法再决策、任务永久卡死（无法恢复）。
      const pendingHumanState = t.humanState;
      const pendingDecision = t.decisions[t.decisions.length - 1];
      t.status = 'running';
      t.humanState = null;
      t.error = undefined;
      await store.saveTask(t);
      try {
        // 决策历史（含刚记录的这条）→ 重放映射：重走图时已审批 human 不再重复暂停
        const { runId } = await bridge.startTask(t, {
          decision: { humanId, value: decision, ...(feedback ? { feedback } : {}) },
          initialResults: results,
          decided: buildDecidedMap(t),
        });
        sendJson(c.res, 200, { task: t, runId });
      } catch (e) {
        dbg('decide: startTask 抛错', {
          taskId: c.params.id, decision,
          isRunAlreadyActive: e instanceof RunAlreadyActiveError,
          error: e instanceof Error ? e.message : String(e),
        });
        if (e instanceof RunAlreadyActiveError) {
          // 并发守卫拒绝 = 决策未被编排器消费（新 run 没起来）。回滚到 waiting-human，
          // 保留 humanState 与决策历史供用户重试，而不是留下一个卡死的 running 任务。
          await store.mutateTask(c.params.id, (tt) => {
            tt.status = 'waiting-human';
            tt.humanState = pendingHumanState;
            tt.currentStage = pendingHumanState?.humanId || tt.currentStage;
            tt.error = undefined;
            // 去掉刚追加但未生效的决策（避免 buildDecidedMap 重放成"已决策"跳过 human）
            if (pendingDecision) {
              const idx = (tt.decisions || []).findIndex((d) => d === pendingDecision || (d.humanId === pendingDecision.humanId && d.at === pendingDecision.at));
              if (idx >= 0) tt.decisions = (tt.decisions || []).filter((_, i) => i !== idx);
            }
          }).catch(() => {});
          return sendJson(c.res, 409, { error: e.message });
        }
        // 决策后启动失败（非并发）：humanState 已清、决策已记录——无法回滚，但至少要标记 failed，避免任务卡 running
        await store.mutateTask(c.params.id, (tt) => {
          tt.status = 'failed';
          tt.error = `决策后继续失败：${e instanceof Error ? e.message : String(e)}`;
          tt.finishedAt = nowIso();
        }).catch(() => {});
        sendJson(c.res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }],
    ['POST', '/tasks/:id/archive', async (c) => {
      // 归档（SPEC-board-redesign 增量）：任务存在才生效，写 archivedAt 时间戳
      const id = c.params.id;
      const task = await store.getTask(id);
      if (!task) return sendJson(c.res, 404, { error: 'task not found' });
      await store.mutateTask(id, (t) => { t.archivedAt = Date.now(); });
      sendJson(c.res, 200, { ok: true });
    }],
    ['POST', '/tasks/:id/restore', async (c) => {
      // 恢复归档（SPEC-board-redesign 增量）：清除 archivedAt，任务回到主列表
      const id = c.params.id;
      const task = await store.getTask(id);
      if (!task) return sendJson(c.res, 404, { error: 'task not found' });
      await store.mutateTask(id, (t) => { delete t.archivedAt; });
      sendJson(c.res, 200, { ok: true });
    }],
    ['DELETE', '/tasks/:id', async (c) => {
      // 运行中的任务先取消，避免 finalizeTask 在目录删除后写回失败 / parent 滞留
      bridge.cancelTask(c.params.id);
      await store.deleteTask(c.params.id);
      sendJson(c.res, 200, { ok: true });
    }],
    // 阶段产物（断点数据，供 UI 展示）
    ['GET', '/tasks/:id/stages/:stageId', async (c) => {
      const data = await store.readStage(c.params.id, c.params.stageId);
      sendJson(c.res, 200, data === null ? { data: null } : { data });
    }],
    // 任务产出物（编排器 results 落盘结果，供详情页「产物」区展示）
    ['GET', '/tasks/:id/results', async (c) => {
      const results = await store.readResults(c.params.id);
      sendJson(c.res, 200, results === null ? { results: null } : { results });
    }],
    // 读取任务工作目录下的文件/目录（供审批与详情页预览产物；限制在 cwd 内 + 大小上限）
    // 返回：
    //   - 文件：{ path, content }（文本 UTF-8；二进制返回 meta）
    //   - 目录：{ path, isDir: true, entries: [{ name, path, isDir, size, ext }] }（单层列表）
    ['GET', '/tasks/:id/file', async (c) => {
      const t = await store.getTask(c.params.id);
      if (!t) return sendJson(c.res, 404, { error: 'task not found' });
      const cwd = t.cwd;
      if (!cwd) return sendJson(c.res, 400, { error: 'task has no cwd' });
      const rel = c.url.searchParams.get('path') || '';
      if (!rel.trim()) return sendJson(c.res, 400, { error: 'path required' });
      const abs = resolve(cwd, rel.trim());
      // 严格路径校验：用 path.relative 判断 abs 是否真的在 cwd 内。
      // （旧的 startsWith 检查在 cwd 为盘符根目录如 C:\ 时会失效，可越权读任意文件。）
      const relCheck = relative(cwd, abs);
      if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
        return sendJson(c.res, 400, { error: 'path outside task cwd' });
      }
      try {
        // symlink/junction 逃逸防护：realpath 解析后再次校验真实路径在 realpath(cwd) 内
        const [realCwd, realAbs] = await Promise.all([realpath(cwd), realpath(abs)]);
        const relReal = relative(realCwd, realAbs);
        if (relReal.startsWith('..') || isAbsolute(relReal)) {
          return sendJson(c.res, 400, { error: 'path escapes task cwd via symlink' });
        }
        const st = await stat(abs);
        if (st.isDirectory()) {
          // 目录：返回单层条目（文件名/相对路径/是否目录/大小），由前端逐级浏览
          const names = await readdir(abs).catch(() => []);
          const entries = [];
          for (const name of names.sort((a, b) => a.localeCompare(b))) {
            const child = join(abs, name);
            try {
              const cs = await stat(child);
              entries.push({
                name,
                path: join(rel.trim(), name).replace(/\\/g, '/'),
                isDir: cs.isDirectory(),
                size: cs.isFile() ? cs.size : 0,
                ext: cs.isFile() && name.includes('.') ? name.split('.').pop().toLowerCase() : '',
              });
            } catch { /* 跳过不可读条目 */ }
          }
          return sendJson(c.res, 200, { path: abs, isDir: true, entries });
        }
        if (!st.isFile()) return sendJson(c.res, 400, { error: 'not a file' });
        if (st.size > 200 * 1024) {
          return sendJson(c.res, 200, { path: abs, meta: { name: rel.trim().split(/[\\/]/).pop(), size: st.size, ext: rel.trim().includes('.') ? rel.trim().split('.').pop().toLowerCase() : '' }, tooLarge: true });
        }
        const content = await readFile(abs, 'utf8');
        sendJson(c.res, 200, { path: abs, content });
      } catch (e) {
        sendJson(c.res, 404, { error: `read failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    }],
  ];

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.slice(prefix.length) || '/';
    const method = req.method ?? 'GET';
    try {
      for (const [m, pattern, fn] of routes) {
        if (m !== method) continue;
        const match = matchRoute(pattern, path);
        if (!match) continue;
        await fn({ req, res, url, params: match });
        return;
      }
      sendJson(res, 404, { error: `no route for ${method} ${path}` });
    } catch (error) {
      // 类型化错误自带 status（如 readBody 超限 = 413）；其余按 500 处理
      const status = typeof error?.status === 'number' ? error.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    }
  };
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: prefix, handler }), 'dsh-knj-workflow: http routes');
}

function matchRoute(pattern, path) {
  const parts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (parts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    else if (parts[i] !== pathParts[i]) return null;
  }
  return params;
}

// ---------------------------------------------------------------------------
// 命令注册：/dev-task
// ---------------------------------------------------------------------------
function registerCommands(ctx, store, bridge) {
  const commands = ctx.get('commands');
  if (!commands) return;

  // ctx.effect 持有返回的 disposer：插件卸载/HMR 时注销命令，否则旧 handler 常驻
  // 命令表（引用已卸载的 store/bridge，执行即幽灵副作用）。
  ctx.effect(() => commands.register({
    name: 'dev-task',
    description: '开发任务编排：/dev-task new <标题> 新建任务；/dev-task list 查看任务；/dev-task status <id> 查看进度；/dev-task wf 列出工作流',
    async execute(line) {
      const raw = (line || '').trim();
      const [cmd, ...rest] = raw.split(/\s+/);
      const arg = rest.join(' ');
      try {
        if (cmd === 'new') {
          if (!arg) return { success: false, text: '用法：/dev-task new <任务标题>' };
          const workflow = (await store.listWorkflows())[0];
          if (!workflow) return { success: false, text: '没有可用的工作流，请先在「开发任务 → 工作流」中创建' };
          const task = {
            id: `task-${Date.now().toString(36)}`,
            title: arg,
            workflowId: workflow.id,
            workflowRevision: workflow.revision || 1,
            workflowSnapshot: workflow,
            status: 'pending',
            stageStates: orderTaskNodesByFlow(workflow).map((id) => {
              const n = workflow.nodes.find((x) => x.id === id);
              return { id, title: n?.title || id, status: 'pending' };
            }),
            createdAt: nowIso(),
          };
          await store.saveTask(task);
          try {
            await bridge.startTask(task);
          } catch (e) {
            if (e instanceof RunAlreadyActiveError) {
              return { success: false, text: `任务 ${task.id} 已创建，但已有运行中的 run，请稍候在面板续跑` };
            }
            // 与 POST /tasks 一致：启动失败落库为 failed，避免任务永久停在 pending
            await store.mutateTask(task.id, (tt) => {
              tt.status = 'failed';
              tt.error = `启动失败：${e instanceof Error ? e.message : String(e)}`;
              tt.finishedAt = nowIso();
            }).catch(() => {});
            return { success: false, text: `任务 ${task.id} 已创建但启动失败：${e instanceof Error ? e.message : String(e)}。可在「开发任务」面板修复后重新启动。` };
          }
          task.status = 'running';
          task.startedAt = nowIso();
          await store.saveTask(task);
          return { success: true, text: `已创建并启动任务 ${task.id}（${task.title}），工作流：${workflow.name}。查看进度：/dev-task status ${task.id}` };
        }
        if (cmd === 'list') {
          const tasks = await store.listTasks();
          if (tasks.length === 0) return { success: true, text: '暂无任务。创建：/dev-task new <标题>' };
          const lines = tasks.map((t) => `• ${t.id} [${t.status}] ${t.title}${t.currentStage ? ` → 阶段:${t.currentStage}` : ''}`);
          return { success: true, text: `任务列表（${tasks.length}）：\n${lines.join('\n')}` };
        }
        if (cmd === 'status') {
          if (!arg) return { success: false, text: '用法：/dev-task status <任务id>' };
          const t = await store.getTask(arg);
          if (!t) return { success: false, text: `任务 ${arg} 不存在` };
          const steps = (t.stageStates || []).map((s) => `${s.status === 'done' ? '✅' : s.status === 'running' ? '🔵' : '⬜'} ${s.title}`).join('  ');
          return { success: true, text: `${t.id} [${t.status}] ${t.title}\n工作流：${t.workflowId}\n进度：${steps}` };
        }
        if (cmd === 'wf') {
          const list = await store.listWorkflows();
          const lines = list.map((w) => `• ${w.id}：${w.name}（${(w.nodes || []).filter((n) => n.type === 'task').length} 个阶段）`);
          return { success: true, text: `工作流（${list.length}）：\n${lines.join('\n')}` };
        }
        return { success: false, text: '未知子命令。用法：/dev-task new|list|status|wf' };
      } catch (e) {
        return { success: false, text: `命令执行失败：${e instanceof Error ? e.message : String(e)}` };
      }
    },
  }), 'dsh-knj-workflow: dev-task command');
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------
export function apply(ctx, config) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const dataRoot = config.dataRoot || join(home, 'dev-orchestrator');
  const store = new DevTaskStore(dataRoot);
  // 文件入参的上传暂存（表单打开时任务还没建，先落这里；startTask 启动前物化进工作区）
  const uploads = new UploadStore(join(dataRoot, 'uploads'));

  let bridge = null;
  let disposed = false;
  // 卸载清理：取消全部活跃 run（否则 subagent 群在插件卸载后继续烧 LLM 成本）；
  // disposed 标记让晚到的 init 不再注册路由/命令（注册在已卸载 ctx 上会泄漏成僵尸 handler）。
  ctx.effect(() => () => {
    disposed = true;
    try { bridge?.cancelAll(); } catch { /* best effort */ }
  }, 'dsh-knj-workflow: cancel runs on dispose');

  store.init().then(() => {
    if (disposed) return;
    bridge = new WorkflowBridge(ctx, store, config.orchestratorScript, uploads);
    ctx.effect(() => ctx.provide('knjWorkflowScheduler', createKnjWorkflowSchedulerService(store, bridge)), 'dsh-knj-workflow: scheduler service');
    registerRoutes(ctx, store, bridge, config.httpPrefix, uploads);
    registerCommands(ctx, store, bridge);
    // 过期上传暂存清理（表单开了没提交的文件不会永久占盘）
    uploads.pruneStale()
      .then((n) => { if (n > 0) ctx.logger?.info?.(`清理过期上传暂存 ${n} 个`); })
      .catch(() => {});
    ctx.logger?.info?.(`dsh-knj-workflow ready @ ${dataRoot}`);
  }).catch((error) => {
    ctx.logger?.warn?.(`dsh-knj-workflow init failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
