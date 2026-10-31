/**
 * Host /tasks/:id/file 目录/文件预览路由测试（node:test）
 * 覆盖：目录返回 entries、文件返回 content、md 文件、路径越界拒绝。
 * 运行：node --test lib/file-preview.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRoutes } from './index.js';

function makeCtxStoreBridge(tmpCwd, taskId = 'task-f') {
  const task = { id: taskId, title: 'F', cwd: tmpCwd };
  const store = {
    tasksDir: '.tasks',
    getTask: async (id) => (id === taskId ? { ...task } : null),
    saveTask: async () => {}, mutateTask: async () => {},
  };
  const bridge = { isRunning: () => false, startTask: async () => ({ runId: 'r' }), cancelTask() {} };
  const registrations = [];
  const ctx = { effect(fn) { fn(); return () => {}; }, webServer: { register: (r) => registrations.push(r) } };
  registerRoutes(ctx, store, bridge, '');
  const handler = registrations[0].handler;
  const call = async (url) => {
    const req = new EventEmitter();
    req.method = 'GET';
    req.url = url;
    const res = { headersSent: false, statusCode: 0, body: null, writeHead(s) { this.statusCode = s; this.headersSent = true; }, end(d) { this.body = d ? JSON.parse(d) : null; } };
    process.nextTick(() => { req.emit('end'); });
    await handler(req, res);
    return res;
  };
  return { handler, call };
}

test('file 路由：目录返回单层 entries（含 isDir/name/size），文件返回 content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knj-file-'));
  try {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', '设计.md'), '# 设计文档\n\n- 要点A\n', 'utf8');
    writeFileSync(join(dir, 'notes.txt'), 'hello', 'utf8');
    const { call } = makeCtxStoreBridge(dir);

    // 根目录 "."：同时含 docs 子目录与 notes.txt
    const rootRes = await call('/tasks/task-f/file?path=.');
    assert.equal(rootRes.statusCode, 200, JSON.stringify(rootRes.body));
    assert.equal(rootRes.body.isDir, true);
    assert.ok(rootRes.body.entries.some((e) => e.name === 'docs' && e.isDir), JSON.stringify(rootRes.body.entries));
    assert.ok(rootRes.body.entries.some((e) => e.name === 'notes.txt' && !e.isDir), JSON.stringify(rootRes.body.entries));

    // 子目录 docs：只含 设计.md
    const dirRes = await call('/tasks/task-f/file?path=docs');
    assert.equal(dirRes.statusCode, 200, JSON.stringify(dirRes.body));
    assert.equal(dirRes.body.isDir, true);
    assert.ok(dirRes.body.entries.some((e) => e.name === '设计.md' && !e.isDir && e.ext === 'md'), JSON.stringify(dirRes.body.entries));
    assert.equal(dirRes.body.entries.length, 1, JSON.stringify(dirRes.body.entries));

    // 文件
    const fileRes = await call('/tasks/task-f/file?path=docs%2F%E8%AE%BE%E8%AE%A1.md');
    assert.equal(fileRes.statusCode, 200, JSON.stringify(fileRes.body));
    assert.match(fileRes.body.content, /设计文档/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('file 路由：路径越界（..）拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knj-file-'));
  try {
    const { call } = makeCtxStoreBridge(dir);
    const res = await call('/tasks/task-f/file?path=..%2Fsecret');
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.match(res.body?.error || '', /outside|escape/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
