/**
 * 复现 2：decide 路由的状态破坏顺序。
 * 现场：任务 waiting-human（humanState 有值）→ 用户点驳回 → decide 路由先
 *        t.status='running'; t.humanState=null; saveTask → 再 bridge.startTask。
 *        若此刻 runs Map 仍残留旧 run（decide 前的 run 尚未清理/或并发 run 活跃），
 *        startTask 抛 RunAlreadyActiveError → 路由返回 409 但不恢复任务状态 →
 *        任务永久卡 running + humanState 已丢 → 无法再次决策、resume 也被 isRunning 挡住。
 * 运行：node --test lib/repro-decide-order.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerRoutes, RunAlreadyActiveError } from './index.js';

const WF = {
  id: 'wf1', name: 'WF',
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'task-1', type: 'task', title: 'A', body: { prompt: 'p' } },
    { id: 'human-1', type: 'human', title: '审批', routes: [{ label: '通过', to: 'task-2' }, { label: '不通过', to: 'task-3' }] },
    { id: 'task-2', type: 'task', title: 'B', body: { prompt: 'p' } },
    { id: 'task-3', type: 'task', title: 'C', body: { prompt: 'p' } },
    { id: 'end', type: 'end' },
  ],
  edges: [
    { from: 'start', to: 'task-1' }, { from: 'task-1', to: 'human-1' },
    { from: 'task-2', to: 'end' }, { from: 'task-3', to: 'end' },
  ],
};

function makeWaitingTask() {
  return {
    id: 'task-w', title: 'W', workflowId: 'wf1', cwd: 'D:/w', workflowSnapshot: WF,
    status: 'waiting-human',
    currentStage: 'human-1',
    humanState: { humanId: 'human-1', results: { 'task-1': { ok: true } } },
    stageStates: [
      { id: 'task-1', status: 'done' }, { id: 'task-2', status: 'pending' }, { id: 'task-3', status: 'pending' },
    ],
  };
}

/** 路由直驱：bridge.startTask 抛 RunAlreadyActiveError（模拟 decide 前旧 run 尚未清理/有并发 run） */
test('decide：startTask 被 409 拒绝时不得破坏 waiting-human 任务状态（可重试）', async () => {
  let saved = null;
  const store = {
    tasksDir: '.tasks',
    async getTask(id) { return id === 'task-w' ? JSON.parse(JSON.stringify(saved)) : null; },
    async saveTask(t) { saved = JSON.parse(JSON.stringify(t)); },
    async mutateTask(id, fn) { if (saved && saved.id === id) { fn(saved); } },
    async saveResults() {}, async readResults() { return {}; }, async readStage() { return null; },
  };
  const bridge = {
    isRunning: () => true, // decide 前仍有活跃 run（旧 run 残留 / 并发）
    async startTask() { throw new RunAlreadyActiveError('任务 task-w 已有运行中的 run'); },
  };
  const registrations = [];
  registerRoutes({ effect(fn) { fn(); return () => {}; }, webServer: { register: (r) => registrations.push(r) } }, store, bridge, '');
  const { handler } = registrations[0]; // register({ kind:'prefix', path, handler })

  saved = makeWaitingTask();
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/tasks/task-w/decide';
  const res = { headersSent: false, statusCode: 0, body: null, writeHead(s) { this.statusCode = s; this.headersSent = true; }, end(d) { this.body = d ? JSON.parse(d) : null; } };
  process.nextTick(() => { req.emit('data', JSON.stringify({ decision: '不通过', feedback: 'x' })); req.emit('end'); });
  await handler(req, res);

  assert.equal(res.statusCode, 409, '并发守卫应 409');
  assert.equal(saved.status, 'waiting-human',
    'BUG：startTask 被拒后任务状态被改成 running，卡死且 humanState 已丢（无法重试决策）');
  assert.ok(saved.humanState, 'BUG：humanState 被清空，任务无法再次 decide');
});
