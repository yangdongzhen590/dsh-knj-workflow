/**
 * 运行时演练（隔离进程，不碰运行中的 profile / 真实数据）
 * 目标：用**已安装的 2026.10.219 代码**，在临时目录 + 本地端口上跑真实 HTTP 链路，证明：
 *   D1 ② Host：自定义前缀 /knj-api 时，固定发现端点仍返回真实前缀
 *   D2 ② Host：自定义前缀下业务路由真的挂在 /knj-api
 *   D3 ② Client：已安装 bundle 里的 resolvePrefix 能跨 HTTP 读到 /knj-api
 *   D4 ② Client：老宿主（无发现端点，404）时回退 /devtask
 *   D5 ③ store：损坏的 workflows.json 被隔离为 .corrupt-<ts>，且仍能注入默认工作流
 *   D6 ③ store：带 BOM 的 task.json 可解析（不再静默消失）
 *   D7 ③ 幂等：第二次 init 不会再产生第二个 .corrupt 文件
 * 运行：node reo/verify/integration-drill.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import vm from 'node:vm';

const INSTALLED = join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-knj-workflow');
const PORT = 8793;
const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`); };

async function loadInstalledHost() {
  const p = join(INSTALLED, 'lib', 'index.js');
  return await import(pathToFileURL(p).href);
}
function loadInstalledClient() {
  globalThis.window = { __ModuleLoader__: { load(spec) {
    const require = (id) => {
      if (id === 'react') return { Component: class {} };
      if (id === 'react-dom/client') return {};
      throw new Error('unexpected require: ' + id);
    };
    loaded = spec.factory(require);
  } } };
  globalThis.document = {
    createElement: (tag) => ({ tag, style: {}, setAttribute() {}, appendChild() {}, click() {}, remove() {} }),
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
    documentElement: { setAttribute() {}, removeAttribute() {} },
    querySelector: () => null,
    addEventListener() {},
  };
  globalThis.Blob = class { constructor() {} };
  globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.URL.revokeObjectURL = () => {};
  let loaded = null;
  vm.runInThisContext(readFileSync(join(INSTALLED, 'lib', 'client.js'), 'utf8'), { filename: 'client.js' });
  return loaded;
}
import { readFileSync } from 'node:fs';

/** 复刻宿主 webServer 的派发：exact 先匹配，再最长前缀；handler 收到完整 req.url。 */
function mount(routes) {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const exact = routes.find((r) => r.kind === 'exact' && r.path === url.pathname);
    if (exact) return void exact.handler(req, res);
    const prefixes = routes.filter((r) => r.kind === 'prefix' && (url.pathname === r.path || url.pathname.startsWith(r.path + '/')))
      .sort((a, b) => b.path.length - a.path.length);
    if (prefixes.length) return void prefixes[0].handler(req, res);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no route' }));
  });
}
function captureRoutes(host, prefix, dataRoot) {
  const regs = [];
  const ctx = {
    effect: (fn) => { const d = fn(); return () => { try { d?.(); } catch {} }; },
    get: () => undefined,
    logger: { info() {}, warn() {} },
    webServer: { register: (r) => { regs.push(r); return () => {}; } },
  };
  const store = new host.DevTaskStore(dataRoot);
  host.registerRoutes(ctx, store, {}, prefix, null);
  return { regs, store };
}
const listen = (server, port) => new Promise((r) => server.listen(port, '127.0.0.1', r));
/** 优雅收尾：先断 keep-alive 连接再 close，避免 undici socket 与 libuv 关闭竞态导致 abort。 */
const closeServer = (server) => new Promise((resolve) => {
  server.close(() => resolve());
  server.closeAllConnections?.();
});

async function main() {
  const host = await loadInstalledHost();
  const client = loadInstalledClient();
  const version = JSON.parse(readFileSync(join(INSTALLED, 'package.json'), 'utf8')).version;
  console.log(`已安装代码: ${INSTALLED} @ ${version}`);

  // ---- D1/D2：自定义前缀 + 固定发现端点 ----
  const root = await mkdtemp(join(tmpdir(), 'knj-drill-'));
  const { regs, store } = captureRoutes(host, '/knj-api', join(root, 'data'));
  await store.init();
  const server = mount(regs);
  await listen(server, PORT);
  const base = `http://127.0.0.1:${PORT}`;

  const meta = await (await fetch(`${base}/knj-workflow/meta`)).json();
  check('D1 Host 发现端点', meta.prefix === '/knj-api' && meta.plugin === 'dsh-knj-workflow', JSON.stringify(meta));

  const health = await (await fetch(`${base}/knj-api/health`)).json();
  check('D2 业务路由挂在自定义前缀', health.ok === true, JSON.stringify(health));

  const oldPath = await fetch(`${base}/devtask/health`);
  check('D2b 旧前缀确已不存在', oldPath.status === 404, `status=${oldPath.status}`);

  // ---- D3：已安装 client 的 resolvePrefix 跨 HTTP 读真实前缀 ----
  const resolved = await client.__test.resolvePrefix((u, o) => fetch(base + u, o));
  check('D3 Client resolvePrefix 读到 /knj-api', resolved === '/knj-api', resolved);

  // ---- D4：模拟老宿主（无发现端点）→ 回退 ----
  const fallback = await client.__test.resolvePrefix(() => fetch(`${base}/__no_such_endpoint`));
  check('D4 无端点时回退 /devtask', fallback === '/devtask', fallback);

  await closeServer(server);

  // ---- D5/D6/D7：store 健壮性 ----
  const data2 = join(root, 'data2');
  await mkdir(data2, { recursive: true });
  await writeFile(join(data2, 'workflows.json'), '{ "workflows": [ { "id": "x",, } ] }', 'utf8');
  const s2 = new host.DevTaskStore(data2);
  await s2.init();
  const entries = await readdir(data2);
  const corrupted = entries.filter((n) => n.startsWith('workflows.json.corrupt-'));
  check('D5 损坏 workflows.json 被隔离', corrupted.length === 1, corrupted.join(',') || '(none)');
  const wfs = await s2.listWorkflows();
  check('D5b 仍有可用默认工作流', Array.isArray(wfs) && wfs.length >= 1, `workflows=${wfs.length}`);

  const taskDir = join(data2, 'tasks', 'task-bom');
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, 'task.json'), '\uFEFF' + JSON.stringify({ id: 'task-bom', title: 'BOM 任务', status: 'success', createdAt: '2026-01-01T00:00:00.000Z' }), 'utf8');
  const list = await s2.listTasks();
  check('D6 BOM task.json 可读', list.some((t) => t.id === 'task-bom'), `tasks=${list.map((t) => t.id).join(',')}`);

  // D7 幂等：再次 init 不应再隔离（损坏文件已被改名，原路径不存在）
  await s2.init();
  const entries2 = await readdir(data2);
  const corrupted2 = entries2.filter((n) => n.startsWith('workflows.json.corrupt-'));
  check('D7 二次 init 幂等', corrupted2.length === 1, `corrupt 文件数=${corrupted2.length}`);

  await rm(root, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'ALL PASS' : 'FAILED'}  (${results.length - failed.length}/${results.length})`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => { console.error('DRILL ERROR', e); process.exit(2); });
