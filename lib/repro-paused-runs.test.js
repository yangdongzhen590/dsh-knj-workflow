/**
 * 复现：human paused 后 runs Map 是否残留（导致 decide/resume 被并发守卫 409 卡死）。
 * 现场：task-mtk40fjd 点驳回后任务卡 running，resume 返回 409「任务正在取消/运行中」，
 *       且没有创建第二个 parent 会话 → decide 的 startTask 在 runs.has 处抛 RunAlreadyActiveError。
 * 运行：node --test lib/repro-paused-runs.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowBridge, RunAlreadyActiveError } from './index.js';

const WF_HUMAN = {
  id: 'wf-human', name: 'H',
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'task-1', type: 'task', title: 'T1', body: { prompt: 'p1' } },
    { id: 'human-1', type: 'human', title: '审批', routes: [{ label: '通过', to: 'task-2' }, { label: '不通过', to: 'task-3' }] },
    { id: 'task-2', type: 'task', title: 'T2', body: { prompt: 'p2' } },
    { id: 'task-3', type: 'task', title: 'T3', body: { prompt: 'p3' } },
    { id: 'end', type: 'end' },
  ],
  edges: [
    { from: 'start', to: 'task-1' }, { from: 'task-1', to: 'human-1' },
    { from: 'task-2', to: 'end' }, { from: 'task-3', to: 'end' },
  ],
};

function makeTask() {
  return { id: 'task-x', title: 'X', workflowId: 'wf-human', cwd: 'D:/w', workflowSnapshot: WF_HUMAN };
}

/** 内存态 store：getTask/mutateTask/saveTask/saveResults 真实生效，供 decide 路由校验 humanState */
function makeStore() {
  let task = null;
  const results = {};
  return {
    tasksDir: '.tasks',
    async getWorkflow() { return WF_HUMAN; },
    async getTask(id) { return task && task.id === id ? JSON.parse(JSON.stringify(task)) : null; },
    async saveTask(t) { task = JSON.parse(JSON.stringify(t)); },
    async mutateTask(id, fn) { if (task && task.id === id) { fn(task); } },
    async saveResults(id, r) { Object.assign(results, r); },
    async readResults() { return { ...results }; },
    async writeStage() {}, async readStage() { return null; },
  };
}

/** ctx mock：agents.create 提供 parent，engine.start 返回可编程 result 的 run */
function makeEnv(resultProvider) {
  const created = [];
  const engine = {
    start() {
      return {
        id: 'run-' + created.length,
        cancel() {},
        dispose() {},
        result: Promise.resolve(typeof resultProvider === 'function' ? resultProvider(created.length) : resultProvider),
      };
    },
  };
  const parentAgent = { id: 'parent-1', scope: { ctx: { get: (n) => (n === 'workflowEngine' ? engine : undefined) } } };
  const seed = { session: { header: { cwd: 'D:/w' } }, options: {} };
  const ctx = {
    on() {}, off() {},
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'agents') return {
        currentInitiator: () => seed,
        roots: () => [seed],
        async create(opts) { created.push(opts); return { agent: parentAgent, dispose: async () => {} }; },
      };
      return undefined;
    },
  };
  return { ctx, store: makeStore(), created, engine };
}

test('复现：第一次 run paused 结束后 runs 应清理，isRunning 应为 false', async () => {
  const { ctx, store } = makeEnv({ stopReason: 'completed', value: { paused: true, pausedAt: 'human-1', results: { 'task-1': { ok: true } }, stageLog: [{ id: 'task-1' }] } });
  const bridge = new WorkflowBridge(ctx, store, 'script');
  const task = makeTask();
  await bridge.startTask(task, {});
  assert.equal(bridge.isRunning(task.id), true, '启动后应运行中');

  // 等 run.result.then 的清理（monitorRun 在 result settle 后删 runs）
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bridge.isRunning(task.id), false,
    'BUG：paused 后 runs 未清理，decide/resume 会被并发守卫 409 卡死');
});

test('复现：paused 清理后，decide 再次 startTask 必须成功（不被 409 拒）', async () => {
  let calls = 0;
  const { ctx, store } = makeEnv(() => {
    calls++;
    // 第一次 run：跑到 human 暂停；第二次 run：正常完成（本次只验证 startTask 不被拒）
    return calls === 1
      ? { stopReason: 'completed', value: { paused: true, pausedAt: 'human-1', results: { 'task-1': { ok: true } }, stageLog: [{ id: 'task-1' }] } }
      : { stopReason: 'completed', value: { results: { 'task-1': { ok: true }, 'task-3': { ok: true } }, stageLog: [{ id: 'task-1' }, { id: 'task-3' }] } };
  });
  const bridge = new WorkflowBridge(ctx, store, 'script');
  const task = makeTask();
  await bridge.startTask(task, {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bridge.isRunning(task.id), false, 'paused 后应可再启动');

  // 模拟 decide 后的第二次启动（带决策继续）
  try {
    await bridge.startTask(task, { decision: { humanId: 'human-1', value: '不通过' }, initialResults: { 'task-1': { ok: true } }, decided: { 'human-1': '不通过' } });
    assert.equal(calls, 2, '第二次 startTask 应成功启动新 run');
  } catch (e) {
    assert.fail('decide 后 startTask 被拒（' + (e instanceof RunAlreadyActiveError ? 'RunAlreadyActiveError: ' : '') + e.message + '）');
  }
});
