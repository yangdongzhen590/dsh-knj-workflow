/**
 * HTTP 前缀发现回归测试（node:test，零依赖）
 * 覆盖：
 *  - Host：除可配前缀路由外，另在固定路径 /knj-workflow/meta 注册只读发现端点（返回真实 prefix）
 *  - Host：新端点不得抢占 registrations[0]（既有测试用它取前缀 handler）
 *  - Client：resolvePrefix 读到 /x 用 /x；404 / 抛错 / 非法值一律回退 /devtask；只发一次请求
 * 运行：node --test lib/prefix-discovery.test.js
 *
 * 背景（现场）：client.js 写死 const PREFIX = '/devtask'，而 Host 的 httpPrefix 是可配的
 * （profile 的 cordis.patch.yml 可覆盖）。用户一改前缀，整个 UI 静默 404 全挂。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { registerRoutes } from './index.js';

const META_PATH = '/knj-workflow/meta';

// ---------- Host 侧 ----------
function captureRoutes(prefix) {
  const registrations = [];
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    webServer: { register: (r) => { registrations.push(r); return () => {}; } },
  };
  const store = { root: '/tmp/knj', listWorkflows: async () => [], listTasks: async () => [] };
  const bridge = {};
  registerRoutes(ctx, store, bridge, prefix, null);
  return registrations;
}

function drive(handler, { method = 'GET', url = META_PATH } = {}) {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    end(data) { this.body = data ?? ''; },
  };
  return Promise.resolve(handler({ method, url }, res)).then(() => res);
}

function metaRoute(registrations) {
  return registrations.find((r) => r.kind === 'exact' && r.path === META_PATH);
}

test('Host：固定发现端点返回真实配置的前缀', async () => {
  const registrations = captureRoutes('/custom-prefix');
  const route = metaRoute(registrations);
  assert.ok(route, `必须注册 ${META_PATH} 发现端点`);
  const res = await drive(route.handler);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).prefix, '/custom-prefix');
  assert.equal(JSON.parse(res.body).plugin, 'dsh-knj-workflow');
});

test('Host：默认前缀下同样注册发现端点（客户端行为一致，不依赖配置值）', async () => {
  const registrations = captureRoutes('/devtask');
  const route = metaRoute(registrations);
  assert.ok(route);
  const res = await drive(route.handler);
  assert.equal(JSON.parse(res.body).prefix, '/devtask');
});

test('Host：发现端点只接受 GET（405），且不抢占 registrations[0]', async () => {
  const registrations = captureRoutes('/devtask');
  assert.equal(registrations[0].kind, 'prefix', '前缀路由必须仍是第一条注册（既有测试按 [0] 取 handler）');
  const route = metaRoute(registrations);
  const res = await drive(route.handler, { method: 'POST' });
  assert.equal(res.statusCode, 405);
});

// ---------- Client 侧 ----------
const createdEls = [];
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      const require = (id) => {
        if (id === 'react') return { Component: class {} };
        if (id === 'react-dom/client') return {};
        throw new Error('unexpected require: ' + id);
      };
      loadedExports = spec.factory(require);
    },
  },
};
globalThis.document = {
  createElement: (tag) => { const el = { tag, click() {}, remove() {} }; createdEls.push(el); return el; },
  body: { appendChild() {}, removeChild() {} },
  documentElement: { setAttribute() {}, removeAttribute() {} },
  querySelector: () => null,
};
globalThis.Blob = class { constructor() {} };
globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL() {} };

let loadedExports = null;
vm.runInThisContext(readFileSync(join(import.meta.dirname, 'client.js'), 'utf8'), { filename: 'client.js' });

const { resolvePrefix, DEFAULT_PREFIX } = loadedExports.__test;

function fakeFetch(impl) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
  fn.calls = calls;
  return fn;
}

test('Client：默认前缀常量与 Host 默认配置一致', () => {
  assert.equal(DEFAULT_PREFIX, '/devtask');
});

test('Client：探测固定路径拿到真实前缀（含去尾斜杠）', async () => {
  const fetchImpl = fakeFetch(async () => ({ ok: true, json: async () => ({ prefix: '/knj' }) }));
  assert.equal(await resolvePrefix(fetchImpl), '/knj');
  assert.equal(fetchImpl.calls[0].url, META_PATH);

  const trailing = fakeFetch(async () => ({ ok: true, json: async () => ({ prefix: '/knj/' }) }));
  assert.equal(await resolvePrefix(trailing), '/knj');
});

test('Client：404 / 抛错 / 非法值一律回退默认前缀', async () => {
  const notFound = fakeFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  assert.equal(await resolvePrefix(notFound), '/devtask');

  const boom = fakeFetch(async () => { throw new Error('network down'); });
  assert.equal(await resolvePrefix(boom), '/devtask');

  for (const bad of [{}, { prefix: 42 }, { prefix: 'knj' }, { prefix: '' }, { prefix: null }]) {
    const f = fakeFetch(async () => ({ ok: true, json: async () => bad }));
    assert.equal(await resolvePrefix(f), '/devtask', JSON.stringify(bad));
  }
});
