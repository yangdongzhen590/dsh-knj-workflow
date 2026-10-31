/**
 * dsh-knj-workflow 需求描述路由/存储测试（node:test）
 *
 * 覆盖 OpenSpec 变更 update-knj-task-requirement-input：
 *  - Lossless UTF-8 request body decoding（跨块多字节字符 + 按字节上限）
 *  - Large requirement text preservation（超阈值落盘 requirement.md + descriptionFile）
 *  - Requirement visibility in list, search, and detail（列表剥离 description + ?q= 全文过滤）
 *  - Requirement import from files（POST /requirement/extract 路由与错误码）
 *
 * 运行：node --test lib/requirement-routes.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { registerRoutes, DevTaskStore, readBody, MAX_BODY_BYTES } from './index.js';
import { INLINE_MAX, REQUIREMENT_FILE_NAME } from './requirement.js';
import { UploadStore } from './uploads.js';

const WF = {
  id: 'wf1', name: 'WF',
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'n1', type: 'task', title: '做一件事', body: { prompt: '根据 ${inputDescription} 干活' } },
    { id: 'end', type: 'end' },
  ],
  edges: [
    { from: 'start', to: 'n1' },
    { from: 'n1', to: 'end' },
  ],
};

/** 声明了一个**必填文件入参** doc 的工作流（文件入参相关用例用）。 */
const WF_FILE = {
  ...WF,
  id: 'wf-file', name: 'WF with file input',
  inputs: [{ name: 'doc', label: '需求文档', required: true, type: 'file' }],
};

function makeRes() {
  return {
    headersSent: false, statusCode: 0, body: null,
    writeHead(s) { this.statusCode = s; this.headersSent = true; },
    end(d) { this.body = d ? JSON.parse(d) : null; },
  };
}

/** 假 req：chunks 为 Buffer 数组（可精确制造跨块多字节切分），nextTick 后投递。 */
function makeReq({ method = 'GET', url = '/', chunks } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.destroyed = false;
  req.destroy = () => { req.destroyed = true; };
  if (chunks) {
    process.nextTick(() => {
      for (const c of chunks) req.emit('data', c);
      req.emit('end');
    });
  }
  return req;
}

function makeHandler(store, bridge = { isRunning: () => false, startTask: async () => ({ runId: 'r-1' }) }, uploads) {
  const regs = [];
  registerRoutes(
    { effect(fn) { fn(); return () => {}; }, webServer: { register: (r) => regs.push(r) } },
    store, bridge, '', uploads,
  );
  return regs[0].handler;
}

const jsonChunks = (obj) => [Buffer.from(JSON.stringify(obj), 'utf8')];

// ---------------------------------------------------------------------------
// readBody：无损 UTF-8 解码 + 字节上限
// ---------------------------------------------------------------------------

test('readBody：多字节字符跨块边界不得被截成 U+FFFD（中文大文本粘贴场景）', async () => {
  const desc = '中文需求描述'.repeat(8000); // UTF-8 约 144KB，必然多块
  const buf = Buffer.from(JSON.stringify({ title: 'T', description: desc }), 'utf8');
  const firstCJK = buf.indexOf(Buffer.from('中', 'utf8'));
  assert.ok(firstCJK > 0, 'fixture 应包含中文');
  // 在 3 字节汉字的第 1 个字节后切开 → 旧实现（逐块 toString）必然产出 U+FFFD
  const split = firstCJK + 1;
  const parsed = await readBody(makeReq({ chunks: [buf.subarray(0, split), buf.subarray(split)] }));

  assert.equal(parsed.description, desc, '跨块解码后必须与原文逐字相同');
  assert.ok(!parsed.description.includes('\uFFFD'), '不得出现替换字符');
});

test('readBody：上限按字节计，超限抛 body-too-large（status 413）', async () => {
  assert.equal(MAX_BODY_BYTES, 1e7, '默认上限 10,000,000 字节');
  const tooBig = Buffer.alloc(MAX_BODY_BYTES + 1, 0x61);
  let err;
  try {
    await readBody(makeReq({ chunks: [tooBig] }));
  } catch (e) { err = e; }
  assert.ok(err, '超限必须拒绝');
  assert.equal(err.status, 413, '应带 413，供路由包装层直接回给客户端');
  assert.match(err.message, /too large/i);
});

test('readBody：空 body 解析为 {}（既有行为不变）', async () => {
  assert.deepEqual(await readBody(makeReq({ chunks: [] })), {});
});

// ---------------------------------------------------------------------------
// POST /tasks：跨块中文描述端到端不丢字 + 超阈值落盘
// ---------------------------------------------------------------------------

test('POST /tasks：分块投递的中文描述落库后与原文一致（无 U+FFFD）', async () => {
  const desc = '需求条目'.repeat(5000);
  const saved = [];
  const store = {
    tasksDir: '.tasks', getWorkflow: async () => WF,
    saveTask: async (t) => { saved.push(t); },
  };
  const handler = makeHandler(store);

  const buf = Buffer.from(JSON.stringify({ id: 'task-x', title: 'T', workflowId: 'wf1', description: desc, autoStart: false }), 'utf8');
  const cjk = buf.indexOf(Buffer.from('需', 'utf8'));
  const req = makeReq({
    method: 'POST', url: '/tasks',
    chunks: [buf.subarray(0, cjk + 2), buf.subarray(cjk + 2)],
  });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].description, desc);
  assert.ok(!saved[0].description.includes('\uFFFD'));
});

test('POST /tasks：超阈值需求全文入库；落盘推迟到启动前（单点 owner = startTask）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-req-'));
  try {
    const desc = '需求内容'.repeat(3000); // 12000 字 > INLINE_MAX
    assert.ok(desc.length > INLINE_MAX);
    const saved = [];
    const store = {
      tasksDir: join(root, 'tasks'), getWorkflow: async () => WF,
      saveTask: async (t) => { saved.push(t); },
    };
    const handler = makeHandler(store);

    const res = makeRes();
    await handler(makeReq({
      method: 'POST', url: '/tasks',
      chunks: jsonChunks({ id: 'task-big', title: 'T', workflowId: 'wf1', description: desc, autoStart: false }),
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(saved[0].description, desc, 'task.json 必须保存全文（不截断）');
    // 落盘统一由 startTask 负责（路由/调度器/命令/续跑都经过它）；autoStart:false 没有 run，
    // 因此此刻还没有 requirement.md。落盘与调度的端到端见 index.test.js 的两条用例。
    assert.equal(saved[0].descriptionFile, undefined, 'autoStart:false 时落盘尚未发生');
    assert.ok(!existsSync(join(root, 'tasks', 'task-big', REQUIREMENT_FILE_NAME)), '未启动前不写需求文件');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /tasks：需求未超阈值 → 不写文件、不记 descriptionFile（旧行为不变）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-req-'));
  try {
    const saved = [];
    const store = {
      tasksDir: join(root, 'tasks'), getWorkflow: async () => WF,
      saveTask: async (t) => { saved.push(t); },
    };
    const handler = makeHandler(store);
    const res = makeRes();
    await handler(makeReq({
      method: 'POST', url: '/tasks',
      chunks: jsonChunks({ id: 'task-small', title: 'T', workflowId: 'wf1', description: '短需求', autoStart: false }),
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(saved[0].description, '短需求');
    assert.equal(saved[0].descriptionFile, undefined);
    assert.ok(!existsSync(join(root, 'tasks', 'task-small', REQUIREMENT_FILE_NAME)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /tasks：描述为空仍可创建（非必填），不写需求文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-req-'));
  try {
    const saved = [];
    const store = {
      tasksDir: join(root, 'tasks'), getWorkflow: async () => WF,
      saveTask: async (t) => { saved.push(t); },
    };
    const handler = makeHandler(store);
    const res = makeRes();
    await handler(makeReq({
      method: 'POST', url: '/tasks',
      chunks: jsonChunks({ id: 'task-empty', title: '未命名任务 09-01 14:30', workflowId: 'wf1', description: '', autoStart: false }),
    }), res);

    assert.equal(res.statusCode, 200, '描述为空不得被拒绝');
    assert.equal(saved[0].description, undefined, '空描述不落库（既有语义）');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /tasks：未给标题时依需求描述派生；显式标题原样保留（命令平面/调度器契约）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-req-title-'));
  try {
    const saved = [];
    const store = {
      tasksDir: join(root, 'tasks'), getWorkflow: async () => WF,
      saveTask: async (t) => { saved.push(t); },
    };
    const handler = makeHandler(store);

    const derived = makeRes();
    await handler(makeReq({
      method: 'POST', url: '/tasks',
      chunks: jsonChunks({ id: 'task-t1', workflowId: 'wf1', description: '## 用户登录优化\n细节…', autoStart: false }),
    }), derived);
    assert.equal(derived.statusCode, 200, '缺标题不得再被 400 拒绝（表单已无标题输入框）');
    assert.equal(saved[0].title, '用户登录优化', '标题取描述首个非空行并去掉 markdown 井号');

    const explicit = makeRes();
    await handler(makeReq({
      method: 'POST', url: '/tasks',
      chunks: jsonChunks({ id: 'task-t2', title: '命令平面给的标题', workflowId: 'wf1', description: '描述', autoStart: false }),
    }), explicit);
    assert.equal(explicit.statusCode, 200);
    assert.equal(saved[1].title, '命令平面给的标题', '显式标题必须原样保留');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 安全：需求落盘不得被 body.id 带出任务目录（路径穿越 / 覆盖任意 requirement.md）
// ---------------------------------------------------------------------------

test('POST /tasks：非法 task id 在拼路径之前就被拒绝，且不得在任务目录外写出任何文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-req-safe-'));
  const outside = join(resolve(root), '..', `knj-escape-${process.pid}-${Date.now()}`);
  try {
    const store = {
      tasksDir: join(root, 'tasks'), getWorkflow: async () => WF,
      saveTask: async () => {},
    };
    const handler = makeHandler(store);
    const outs = ['..\\..\\' + outside.split(/[\\/]/).pop(), '../../' + outside.split(/[\\/]/).pop()];

    for (const badId of outs) {
      const res = makeRes();
      await handler(makeReq({
        method: 'POST', url: '/tasks',
        chunks: jsonChunks({ id: badId, workflowId: 'wf1', description: '恶意内容'.repeat(3000), autoStart: false }),
      }), res);
      assert.equal(res.statusCode, 400, `非法 id 必须是 400（实际 ${res.statusCode}）`);
    }
    assert.ok(!existsSync(outside), '不得在任务目录之外写出 requirement.md（路径穿越）');
    assert.ok(!existsSync(join(root, 'tasks', REQUIREMENT_FILE_NAME)), '不得把需求写到 tasksDir 根（id="." 之类）');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('POST /tasks：id="." 必须被拒（否则会写到 tasksDir 根，污染其它任务目录）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-req-dot-'));
  try {
    const store = { tasksDir: join(root, 'tasks'), getWorkflow: async () => WF, saveTask: async () => {} };
    const handler = makeHandler(store);
    const res = makeRes();
    await handler(makeReq({
      method: 'POST', url: '/tasks',
      chunks: jsonChunks({ id: '.', workflowId: 'wf1', description: '需求'.repeat(4000), autoStart: false }),
    }), res);
    assert.equal(res.statusCode, 400);
    assert.ok(!existsSync(join(root, 'tasks', REQUIREMENT_FILE_NAME)), 'tasksDir 根不得出现 requirement.md');
    assert.ok(!existsSync(join(root, 'tasks', 'task.json')), 'tasksDir 根不得出现 task.json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /tasks：真实 HTTP 下超限请求体必须收到 413（旧实现先 destroy → 客户端只看到连接重置）', async () => {
  const handler = makeHandler({ tasksDir: '.tasks', getWorkflow: async () => WF, saveTask: async () => {} });
  const server = createServer((req, res) => { handler(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'T', workflowId: 'wf1', notes: 'a'.repeat(MAX_BODY_BYTES + 4096) }),
    }).catch((e) => { throw new Error(`客户端未收到 HTTP 响应而是连接层错误：${e.message}`); });
    assert.equal(res.status, 413, '超限必须回 413 而不是断连');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// GET /tasks：列表轻量化 + ?q= 全文过滤
// ---------------------------------------------------------------------------

test('GET /tasks：把 archived 与 q 交给 store，路由不改写载荷', async () => {
  let received = null;
  const listShape = [{ id: 'task-a', title: 'A', descriptionChars: 7, createdAt: '2026-01-01' }];
  const store = {
    tasksDir: '.tasks',
    listTasks: async (filter) => { received = filter; return listShape; },
  };
  const handler = makeHandler(store);
  const res = makeRes();
  await handler(makeReq({ method: 'GET', url: '/tasks?archived=0&q=%E9%9C%80%E6%B1%82' }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(received, { archived: false, q: '需求' }, '路由应把 q 与 archived 一起交给 store');
  assert.deepEqual(res.body.tasks, listShape, '列表载荷形状由 store 负责（与既有 workflowSnapshot 剥离同处），路由只透传');
});

test('GET /tasks：真实 store 端到端——列表不含需求全文、只给字数，且 q 能命中正文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-route-list-'));
  try {
    const store = new DevTaskStore(root);
    const write = (id, task) => {
      mkdirSync(join(root, 'tasks', id), { recursive: true });
      writeFileSync(join(root, 'tasks', id, 'task.json'), JSON.stringify({ id, status: 'pending', ...task }), 'utf8');
    };
    write('task-a', { title: '批量下载', description: '用户可从文件列表勾选多个文件并批量下载', createdAt: '2026-01-01' });
    write('task-b', { title: '登录优化', description: '登录页支持记住我', createdAt: '2026-01-02' });

    const handler = makeHandler(store);
    const all = makeRes();
    await handler(makeReq({ method: 'GET', url: '/tasks' }), all);
    assert.equal(all.statusCode, 200);
    assert.equal(all.body.tasks.length, 2);
    for (const t of all.body.tasks) {
      assert.equal(t.description, undefined, '看板 3s 轮询不得携带需求全文');
      assert.equal(typeof t.descriptionChars, 'number');
    }

    const hit = makeRes();
    await handler(makeReq({ method: 'GET', url: '/tasks?q=' + encodeURIComponent('记住我') }), hit);
    assert.deepEqual(hit.body.tasks.map((t) => t.id), ['task-b'], '需求正文中的词必须能通过 ?q= 命中');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DevTaskStore.listTasks：真实实现剥离全文、给出字数、并按 q 做全文过滤', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-store-'));
  try {
    const store = new DevTaskStore(root);
    const write = (id, task) => {
      mkdirSync(join(root, 'tasks', id), { recursive: true });
      writeFileSync(join(root, 'tasks', id, 'task.json'), JSON.stringify({ id, status: 'pending', ...task }), 'utf8');
    };
    write('task-a', { title: '批量下载', description: '用户可从文件列表勾选多个文件并批量下载', createdAt: '2026-01-01' });
    write('task-b', { title: '登录优化', description: '登录页支持记住我', createdAt: '2026-01-02' });

    const all = await store.listTasks({ archived: false });
    assert.equal(all.length, 2);
    for (const t of all) {
      assert.equal(t.description, undefined, '列表项不得含全文');
      assert.equal(typeof t.descriptionChars, 'number');
    }
    assert.equal(all.find((t) => t.id === 'task-a').descriptionChars, 19);

    const hit = await store.listTasks({ archived: false, q: '批量下载' });
    assert.deepEqual(hit.map((t) => t.id), ['task-a'], '需求正文里的词必须能命中');
    const byTitle = await store.listTasks({ archived: false, q: '记住我' });
    assert.deepEqual(byTitle.map((t) => t.id), ['task-b'], '需求正文（非标题）也能命中');
    assert.deepEqual((await store.listTasks({ archived: false, q: '不存在的词' })).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 文件入参：POST /uploads（暂存）+ POST /tasks 携带 fileInputs（OpenSpec: add-knj-task-file-inputs）
// 旧的 POST /requirement/extract（把文件内容抽进描述）已按该变更移除。
// ---------------------------------------------------------------------------

const uploadsFor = (root) => new UploadStore(join(root, 'uploads'));

test('POST /uploads：暂存并返回 { uploadId, name, size }；文件名消毒成 basename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-route-up-'));
  try {
    const handler = makeHandler({ tasksDir: join(root, 'tasks') }, undefined, uploadsFor(root));
    const res = makeRes();
    await handler(makeReq({
      method: 'POST', url: '/uploads',
      chunks: jsonChunks({ name: '..\\..\\需求文档.md', dataBase64: Buffer.from('# 标题', 'utf8').toString('base64') }),
    }), res);

    assert.equal(res.statusCode, 200);
    assert.match(res.body.uploadId, /^up-/, '应返回可安全用于路径的 uploadId');
    assert.equal(res.body.name, '需求文档.md', '文件名应消毒为 basename');
    assert.equal(res.body.size, Buffer.byteLength('# 标题', 'utf8'));
    assert.ok(existsSync(join(root, 'uploads', res.body.uploadId, '需求文档.md')), '应真的落到暂存目录');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /uploads：超大 / 非法文件名 / 空内容 → 400 + 明确 code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-route-up2-'));
  try {
    const handler = makeHandler({ tasksDir: join(root, 'tasks') }, undefined, uploadsFor(root));
    const cases = [
      [{ name: 'a.md', dataBase64: '' }, 'empty-file'],
      [{ name: '..', dataBase64: Buffer.from('x').toString('base64') }, 'invalid-name'],
      [{ name: 'a.md', dataBase64: '!!!not-base64!!!' }, 'invalid-payload'],
    ];
    for (const [payload, code] of cases) {
      const res = makeRes();
      await handler(makeReq({ method: 'POST', url: '/uploads', chunks: jsonChunks(payload) }), res);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.body.code, code, JSON.stringify(payload));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /tasks：fileInputs 落到 pendingFileInputs（物化在 startTask：任务还没 cwd/目录时不写盘）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-route-fi-'));
  try {
    const saved = [];
    const store = { tasksDir: join(root, 'tasks'), getWorkflow: async () => WF_FILE, saveTask: async (t) => { saved.push(t); } };
    const handler = makeHandler(store, undefined, uploadsFor(root));

    const up = makeRes();
    await handler(makeReq({ method: 'POST', url: '/uploads', chunks: jsonChunks({ name: '需求.md', dataBase64: Buffer.from('# doc', 'utf8').toString('base64') }) }), up);

    const res = makeRes();
    await handler(makeReq({
      method: 'POST', url: '/tasks',
      chunks: jsonChunks({
        id: 'task-files', workflowId: 'wf-file', cwd: root, autoStart: false,
        fileInputs: { doc: { uploadId: up.body.uploadId, name: up.body.name } },
      }),
    }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(saved[0].pendingFileInputs, { doc: { uploadId: up.body.uploadId, name: '需求.md' } });
    assert.equal(saved[0].inputs, undefined, '此时还没有路径可写（物化在启动前）');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /tasks：必填文件入参缺失 → 400 且指出参数名，不创建任务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-route-req-'));
  try {
    const saved = [];
    const store = { tasksDir: join(root, 'tasks'), getWorkflow: async () => WF_FILE, saveTask: async (t) => { saved.push(t); } };
    const handler = makeHandler(store, undefined, uploadsFor(root));

    const res = makeRes();
    await handler(makeReq({
      method: 'POST', url: '/tasks',
      chunks: jsonChunks({ id: 'task-nofile', workflowId: 'wf-file', cwd: root, autoStart: false }),
    }), res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /doc/, '错误信息应指出缺哪个参数');
    assert.equal(saved.length, 0, '不得创建任务');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 内置通用附件（无需声明）：POST /tasks 里的 attachments: [{uploadId, name}] 数组
// 为什么是数组而不是按参数名的对象：附件不属于任何声明参数，用户只是"丢几个文件给节点"。
// ---------------------------------------------------------------------------

test('POST /tasks：attachments 落到 pendingAttachments（无需声明；物化在 startTask 启动前）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-route-att-'));
  try {
    const saved = [];
    // 关键：WF 是**零 inputs 声明**的工作流 —— 附件必须照样收下（否则又回到"没声明就没入口"）
    const store = { tasksDir: join(root, 'tasks'), getWorkflow: async () => WF, saveTask: async (t) => { saved.push(t); } };
    const handler = makeHandler(store, undefined, uploadsFor(root));

    const a = makeRes();
    await handler(makeReq({ method: 'POST', url: '/uploads', chunks: jsonChunks({ name: '说明书.docx', dataBase64: Buffer.from('A', 'utf8').toString('base64') }) }), a);
    const b = makeRes();
    await handler(makeReq({ method: 'POST', url: '/uploads', chunks: jsonChunks({ name: '接口.md', dataBase64: Buffer.from('B', 'utf8').toString('base64') }) }), b);

    const res = makeRes();
    await handler(makeReq({
      method: 'POST', url: '/tasks',
      chunks: jsonChunks({
        id: 'task-att', workflowId: 'wf1', cwd: root, autoStart: false,
        attachments: [
          { uploadId: a.body.uploadId, name: a.body.name },
          { uploadId: b.body.uploadId, name: b.body.name },
        ],
      }),
    }), res);

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(saved[0].pendingAttachments, [
      { uploadId: a.body.uploadId, name: '说明书.docx' },
      { uploadId: b.body.uploadId, name: '接口.md' },
    ], '附件按顺序原样记住（顺序 = 用户选择顺序，写进 inputs.附件 时保持）');
    assert.equal(saved[0].inputs, undefined, '创建时还没有路径（物化在启动前）');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /tasks：附件条目缺 uploadId → 400 且不创建任务（不许静默少文件）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-route-att2-'));
  try {
    const saved = [];
    const store = { tasksDir: join(root, 'tasks'), getWorkflow: async () => WF, saveTask: async (t) => { saved.push(t); } };
    const handler = makeHandler(store, undefined, uploadsFor(root));

    const res = makeRes();
    await handler(makeReq({
      method: 'POST', url: '/tasks',
      chunks: jsonChunks({ id: 'task-bad', workflowId: 'wf1', cwd: root, autoStart: false, attachments: [{ name: '没上传.md' }] }),
    }), res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /uploadId/);
    assert.equal(saved.length, 0, '不得创建任务');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('POST /tasks：attachments 形状不对（字符串/对象）→ 当作没有附件，不炸也不记脏数据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-route-att3-'));
  try {
    const saved = [];
    const store = { tasksDir: join(root, 'tasks'), getWorkflow: async () => WF, saveTask: async (t) => { saved.push(t); } };
    const handler = makeHandler(store, undefined, uploadsFor(root));

    for (const [i, attachments] of ['a.md', { a: 1 }, 42, null].entries()) {
      const res = makeRes();
      await handler(makeReq({
        method: 'POST', url: '/tasks',
        chunks: jsonChunks({ id: `task-shape-${i}`, workflowId: 'wf1', cwd: root, autoStart: false, attachments }),
      }), res);
      assert.equal(res.statusCode, 200, `${JSON.stringify(attachments)} 不该让建任务失败`);
      assert.equal(saved[saved.length - 1].pendingAttachments, undefined, `${JSON.stringify(attachments)} 不该造出附件记录`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('旧路由 POST /requirement/extract 已移除（404），避免两套"文件进工作流"机制并存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-route-gone-'));
  try {
    const handler = makeHandler({ tasksDir: join(root, 'tasks') }, undefined, uploadsFor(root));
    const res = makeRes();
    await handler(makeReq({
      method: 'POST', url: '/requirement/extract',
      chunks: jsonChunks({ name: 'a.md', dataBase64: Buffer.from('x').toString('base64') }),
    }), res);
    assert.equal(res.statusCode, 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

