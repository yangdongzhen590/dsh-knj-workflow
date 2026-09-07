/**
 * dsh-knj-workflow 任务归档（SPEC-board-redesign 增量）测试（node:test）
 *
 * 覆盖：
 *  - GET /tasks 归档过滤（?archived=1 只返回归档；无参返回主列表，不含归档）
 *  - POST /tasks/:id/archive  设置 archivedAt（任务存在时才生效）
 *  - POST /tasks/:id/restore  清除 archivedAt
 *  - store.listTasks({ archived }) 过滤（真实 DevTaskStore 临时目录）
 *
 * 运行：node --test lib/archive.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRoutes, DevTaskStore } from './index.js';

function fakeRes() {
  return {
    headersSent: false, statusCode: 0, body: null,
    writeHead(s) { this.statusCode = s; this.headersSent = true; },
    end(d) { this.body = d ? JSON.parse(d) : null; },
  };
}
function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method; req.url = url;
  if (body !== undefined) process.nextTick(() => { req.emit('data', JSON.stringify(body)); req.emit('end'); });
  else process.nextTick(() => req.emit('end'));
  return req;
}
function mount(store, bridge) {
  const registrations = [];
  registerRoutes({ effect(fn) { fn(); return () => {}; }, webServer: { register: (r) => registrations.push(r) } }, store, bridge, '');
  return registrations[0].handler;
}
const noopBridge = { isRunning: () => false, startTask: async () => ({}), cancelTask() {} };

test('GET /tasks?archived=1 只返回归档任务（listTasks 收到 archived:true）', async () => {
  const seen = [];
  const store = {
    tasksDir: '.tasks',
    listTasks: async (filter) => { seen.push(filter); return [{ id: 'a1', archivedAt: 1 }, { id: 'b1' }]; },
  };
  const handler = mount(store, noopBridge);
  const res = fakeRes();
  await handler(fakeReq('GET', '/tasks?archived=1'), res);
  assert.equal(res.statusCode, 200, '归档列表应 200');
  assert.deepEqual(seen, [{ archived: true }], 'listTasks 应收到 archived:true 过滤');
  assert.deepEqual(res.body.tasks, [{ id: 'a1', archivedAt: 1 }, { id: 'b1' }], '路由透传 store 过滤结果（过滤逻辑在 store.listTasks）');
});

test('GET /tasks（无参）以 archived:false 请求主列表（归档任务不出现）', async () => {
  const seen = [];
  const store = { tasksDir: '.tasks', listTasks: async (filter) => { seen.push(filter); return [{ id: 'b1' }]; } };
  const handler = mount(store, noopBridge);
  const res = fakeRes();
  await handler(fakeReq('GET', '/tasks'), res);
  assert.equal(res.statusCode, 200, '主列表应 200');
  assert.deepEqual(seen, [{ archived: false }], '主列表请求 archived:false');
});

test('POST /tasks/:id/archive 设置 archivedAt（任务存在时）', async () => {
  let mutated = false;
  const store = {
    tasksDir: '.tasks',
    getTask: async (id) => (id === 'task-x' ? { id: 'task-x', status: 'success' } : null),
    mutateTask: async (id, mutator) => {
      mutated = true;
      const t = { id, status: 'success' };
      await mutator(t);
      assert.ok(typeof t.archivedAt === 'number' && t.archivedAt > 0, 'mutator 应设置 archivedAt 时间戳');
      return t;
    },
  };
  const handler = mount(store, noopBridge);
  const res = fakeRes();
  await handler(fakeReq('POST', '/tasks/task-x/archive'), res);
  assert.equal(res.statusCode, 200, 'archive 应成功');
  assert.equal(mutated, true, '应调用 mutateTask');
  assert.equal(res.body.ok, true, '返回 ok:true');
});

test('POST /tasks/:id/archive 对不存在任务返回非 200 且不 mutate', async () => {
  let mutated = false;
  const store = { tasksDir: '.tasks', getTask: async () => null, mutateTask: async () => { mutated = true; } };
  const handler = mount(store, noopBridge);
  const res = fakeRes();
  await handler(fakeReq('POST', '/tasks/ghost/archive'), res);
  assert.notEqual(res.statusCode, 200, '不存在任务不得 200');
  assert.equal(mutated, false, '不得 mutate');
});

test('POST /tasks/:id/restore 清除 archivedAt', async () => {
  const store = {
    tasksDir: '.tasks',
    getTask: async (id) => (id === 'task-x' ? { id: 'task-x', archivedAt: 123 } : null),
    mutateTask: async (id, mutator) => {
      const t = { id: 'task-x', archivedAt: 123 };
      await mutator(t);
      assert.equal(t.archivedAt, undefined, 'mutator 应清除 archivedAt');
      return t;
    },
  };
  const handler = mount(store, noopBridge);
  const res = fakeRes();
  await handler(fakeReq('POST', '/tasks/task-x/restore'), res);
  assert.equal(res.statusCode, 200, 'restore 应成功');
  assert.equal(res.body.ok, true, '返回 ok:true');
});

test('store.listTasks 按 archived 过滤（真实 DevTaskStore 临时目录）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wf-arch-'));
  try {
    const store = new DevTaskStore(root);
    await store.init();
    await store.saveTask({ id: 't1', title: 'A', status: 'success', createdAt: 1, archivedAt: 100 });
    await store.saveTask({ id: 't2', title: 'B', status: 'pending', createdAt: 2 });
    const all = await store.listTasks();
    const archived = await store.listTasks({ archived: true });
    const main = await store.listTasks({ archived: false });
    assert.equal(all.length, 2, '无参返回全部');
    assert.deepEqual(archived.map(t => t.id), ['t1'], 'archived:true 只含归档');
    assert.deepEqual(main.map(t => t.id), ['t2'], 'archived:false 不含归档');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
