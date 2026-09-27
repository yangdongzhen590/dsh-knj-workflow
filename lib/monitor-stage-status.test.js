/**
 * 复现/回归：多轮复用节点时阶段状态被上一轮 done 卡死（进度显示不真实）。
 * 现场：ts 流程第二轮「驳回」时 fix 已在第 1 轮 done，引擎第 2 轮重新执行 fix——
 *       Host onAgentStart 只追加 sessionIds、onPhase 只把 pending/skipped→running，
 *       onAgentEnd 只把 running→done → fix 状态永远停留在 done（旧 finishedAt），
 *       实际却在运行（task-mtu18nd3 实测：显示 fix 已完成 12:06，checkpoint 12:31 才落盘）。
 * 期望：节点主体 subagent 真正启动（agent-start）那一刻，该阶段必须置回 running
 *       （新 startedAt、清 finishedAt），agent-end 再置 done —— 每轮执行都有真实状态。
 * 运行：node --test lib/monitor-stage-status.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowBridge } from './index.js';

const WF = {
  id: 'ts', name: 'ts', nodes: [
    { id: 'start', type: 'start' },
    { id: 'submit', type: 'task', title: 'submit', body: { prompt: 'p' } },
    { id: 'fix', type: 'task', title: 'fix', body: { prompt: 'p' } },
    { id: 'human-1', type: 'human', title: 'human', routes: [{ label: '通过', to: 'end' }, { label: '驳回', to: 'fix' }] },
    { id: 'end', type: 'end' },
  ],
  edges: [
    { from: 'start', to: 'submit' }, { from: 'submit', to: 'human-1' }, { from: 'fix', to: 'submit' },
  ],
};

/** 内存态 store：与 repro-paused-runs 同构，供 mutateTask 事件回调真实生效 */
function makeStore(initialTask) {
  let task = JSON.parse(JSON.stringify(initialTask));
  return {
    tasksDir: '.tasks',
    async getWorkflow() { return WF; },
    async getTask(id) { return task && task.id === id ? JSON.parse(JSON.stringify(task)) : null; },
    async saveTask(t) { task = JSON.parse(JSON.stringify(t)); },
    async mutateTask(id, fn) { if (task && task.id === id) { fn(task); } },
    async saveResults() {}, async readResults() { return {}; },
    async writeStage() {}, async readStage() { return null; },
    snapshot() { return JSON.parse(JSON.stringify(task)); },
  };
}

/** 事件捕获 ctx：monitorRun 注册的 handler 按事件名存起来，测试里手工派发 */
function makeEnv(resultDeferred) {
  const handlers = {};
  const ctx = {
    logger: { info() {}, warn() {} },
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
    off() {},
    get(name) {
      if (name === 'agents') return {
        currentInitiator: () => ({ session: { header: { cwd: 'D:/w' } }, options: {} }),
        roots: () => [{ session: { header: { cwd: 'D:/w' } }, options: {} }],
        async create(opts) { return { agent: { id: 'parent-1', scope: { ctx: { get: (n) => (n === 'workflowEngine' ? engine : undefined) } } }, dispose: async () => {} }; },
      };
      return undefined;
    },
  };
  const engine = {
    start() {
      return {
        id: 'run-1',
        cancel() {},
        dispose() {},
        result: resultDeferred.promise,
      };
    },
  };
  return { ctx, store: makeStore(makeTask()), handlers };
}

function makeTask() {
  return {
    id: 'task-multi', title: 'X', workflowId: 'ts', cwd: 'D:/w', workflowSnapshot: WF,
    status: 'waiting-human', currentStage: 'human-1',
    humanState: { humanId: 'human-1', results: { submit: { ok: true } } },
    stageStates: [
      { id: 'submit', title: 'submit', status: 'done', startedAt: '2026-09-09T11:49:00.000Z', finishedAt: '2026-09-09T11:52:00.000Z', sessionIds: ['s1'] },
      { id: 'fix', title: 'fix', status: 'done', startedAt: '2026-09-09T12:03:00.000Z', finishedAt: '2026-09-09T12:06:00.000Z', sessionIds: ['s2'] },
    ],
  };
}

function defer() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 启动 bridge 并等 run.result 清理落定（避免悬挂 timer） */
async function settled(bridge, deferred) {
  deferred.resolve({ stopReason: 'completed', value: { results: {}, stageLog: [] } });
  await new Promise((r) => setTimeout(r, 50));
}

test('多轮复用节点：agent-start 必须把上轮 done 的阶段置回 running（进度不卡死）', async () => {
  const deferred = defer();
  const { ctx, store, handlers } = makeEnv(deferred);
  const bridge = new WorkflowBridge(ctx, store, 'script');
  const task = makeTask();
  await bridge.startTask(task, { decision: { humanId: 'human-1', value: '驳回' }, initialResults: { submit: { ok: true } }, decided: { 'human-1': '驳回' } });

  // 第二次驳回轮：fix 的主体 subagent 启动（此前 fix 状态为上一轮 done）
  const agentStart = (handlers['workflow/agent-start'] || [])[0];
  assert.ok(agentStart, '应注册 workflow/agent-start 监听');
  await agentStart({ id: 'run-1' }, { phase: 'fix', label: 'fix', childId: 'child-fix-r2' });

  let snap = store.snapshot();
  const fix = snap.stageStates.find((x) => x.id === 'fix');
  assert.equal(fix.status, 'running',
    `BUG：fix 上一轮 done 后再次执行时 agent-start 未置回 running（仍为 ${fix.status}），进度显示卡在已完成`);
  assert.equal(fix.finishedAt, undefined, '重新执行时应清掉上一轮的 finishedAt');
  assert.ok(fix.startedAt && fix.startedAt !== '2026-09-09T12:03:00.000Z', '重新执行应刷新 startedAt');

  // 主体 subagent 结束 → 应置回 done（新 finishedAt）
  const agentEnd = (handlers['workflow/agent-end'] || [])[0];
  assert.ok(agentEnd, '应注册 workflow/agent-end 监听');
  await agentEnd({ id: 'run-1' }, { phase: 'fix', label: 'fix', childId: 'child-fix-r2' });
  snap = store.snapshot();
  const fix2 = snap.stageStates.find((x) => x.id === 'fix');
  assert.equal(fix2.status, 'done', 'agent-end 后应回到 done');
  assert.ok(fix2.finishedAt && fix2.finishedAt !== '2026-09-09T12:06:00.000Z', 'done 的 finishedAt 应为本轮新时间');

  await settled(bridge, deferred);
});
