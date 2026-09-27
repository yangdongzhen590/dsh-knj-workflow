/**
 * 文件入参的上传暂存（node:test，零依赖）
 *
 * 背景（OpenSpec: add-knj-task-file-inputs）：新建任务表单打开时任务还不存在（没有 taskId，
 * 也就没有 `<cwd>/.knj-inputs/<taskId>/`），所以上传必须**先暂存**，等 startTask 启动前再物化到工作区。
 *
 * 安全要点（本插件栽过一次 task id 路径穿越，同类错误不重复）：文件名在拼任何路径之前
 * 必须先消毒成 basename；uploadId 也必须过严格格式校验才允许拼路径。
 *
 * 运行：node --test lib/uploads.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UploadStore, UploadError, sanitizeFileName, MAX_UPLOAD_BYTES, UPLOAD_BODY_BYTES } from './uploads.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

async function withStore(fn) {
  const root = await mkdtemp(join(tmpdir(), 'knj-uploads-'));
  try {
    return await fn(new UploadStore(join(root, 'uploads')), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function rejection(promise) {
  try { await promise; } catch (e) { return e; }
  throw new Error('预期抛错但没有抛');
}

// ---------------------------------------------------------------------------
// 文件名消毒（拼路径之前）
// ---------------------------------------------------------------------------

test('sanitizeFileName：取 basename，剥离路径分隔符（含 Windows 反斜杠）', () => {
  assert.equal(sanitizeFileName('a/b.md'), 'b.md');
  assert.equal(sanitizeFileName('..\\..\\x.docx'), 'x.docx');
  assert.equal(sanitizeFileName('C:\\doc\\需求.docx'), '需求.docx');
  assert.equal(sanitizeFileName('/etc/passwd'), 'passwd');
});

test('sanitizeFileName：剥离 Windows 非法字符与控制字符', () => {
  assert.equal(sanitizeFileName('a<b>:c"d|e?f*g.txt'), 'abcdefg.txt');
  assert.equal(sanitizeFileName('a\u0000b\u001fc.md'), 'abc.md');
});

test('sanitizeFileName：去掉首尾空白与结尾的点（Windows 不允许文件以点/空格结尾）', () => {
  assert.equal(sanitizeFileName('  需求 .md  '), '需求 .md');
  assert.equal(sanitizeFileName('name.'), 'name');
  assert.equal(sanitizeFileName('name. '), 'name');
});

test('sanitizeFileName：完全不可用的名字返回空串（调用方据此报 invalid-name）', () => {
  for (const bad of ['', '   ', '.', '..', '...', '///', '\\', '\u0000']) {
    assert.equal(sanitizeFileName(bad), '', `name=${JSON.stringify(bad)} 应判为不可用`);
  }
});

test('sanitizeFileName：超长名截断但仍保留扩展名、长度有上限', () => {
  const out = sanitizeFileName(`${'字'.repeat(400)}.docx`);
  assert.ok(out.length <= 120, `长度应 ≤120，实际 ${out.length}`);
  assert.ok(out.endsWith('.docx'), '应保留扩展名');
});

// ---------------------------------------------------------------------------
// 暂存 / 解析 / 清理
// ---------------------------------------------------------------------------

test('stage：暂存到 <root>/<uploadId>/<name>，返回 { uploadId, name, size }', async () => {
  await withStore(async (store, root) => {
    const content = '# 需求文档\n正文内容';
    const r = await store.stage({ name: '需求 docx.md', dataBase64: b64(content) });
    assert.match(r.uploadId, /^up-[a-z0-9]+-[a-z0-9]{8}$/, 'uploadId 应可安全用于路径');
    assert.equal(r.name, '需求 docx.md');
    assert.equal(r.size, Buffer.byteLength(content, 'utf8'));
    const staged = join(root, 'uploads', r.uploadId, '需求 docx.md');
    assert.ok(existsSync(staged), '暂存文件应落盘');
    assert.equal(statSync(staged).size, r.size);
  });
});

test('stage：文件名带路径穿越时只保留 basename，绝不写到暂存目录之外', async () => {
  await withStore(async (store, root) => {
    const r = await store.stage({ name: '..\\..\\escape.md', dataBase64: b64('x') });
    assert.equal(r.name, 'escape.md');
    assert.ok(!existsSync(join(root, 'escape.md')), '不得在暂存根之外写出文件');
    const dirs = readdirSync(join(root, 'uploads'));
    assert.equal(dirs.length, 1, '只在暂存根下建一个 uploadId 目录');
  });
});

test('stage：不可用文件名 → invalid-name', async () => {
  await withStore(async (store) => {
    for (const bad of ['', '..', '///']) {
      const e = await rejection(store.stage({ name: bad, dataBase64: b64('x') }));
      assert.ok(e instanceof UploadError, '应是类型化错误');
      assert.equal(e.code, 'invalid-name', `name=${JSON.stringify(bad)}`);
    }
  });
});

test('stage：非法 base64 / 空内容 → invalid-payload / empty-file', async () => {
  await withStore(async (store) => {
    assert.equal((await rejection(store.stage({ name: 'a.md', dataBase64: '!!!' }))).code, 'invalid-payload');
    assert.equal((await rejection(store.stage({ name: 'a.md' }))).code, 'invalid-payload');
    assert.equal((await rejection(store.stage({ name: 'a.md', dataBase64: '' }))).code, 'empty-file');
  });
});

test('stage：按字节上限拒绝（默认 32MB，可由 limits 覆盖）', async () => {
  await withStore(async (store) => {
    assert.equal(MAX_UPLOAD_BYTES, 32 * 1024 * 1024);
    const e = await rejection(store.stage({ name: 'a.bin', dataBase64: Buffer.alloc(64, 1).toString('base64') }, { maxBytes: 10 }));
    assert.equal(e.code, 'file-too-large');
    assert.match(e.message, /过大|too large/i);
  });
});

test('UPLOAD_BODY_BYTES：请求体上限必须容得下最大文件（base64 膨胀 ~4/3）', () => {
  assert.ok(UPLOAD_BODY_BYTES > MAX_UPLOAD_BYTES * 4 / 3, '体上限必须 > base64 后的体积，否则最大文件永远传不进来');
});

test('resolve：合法 id → 路径；非法/不存在的 id → null（id 必须过格式校验才可拼路径）', async () => {
  await withStore(async (store) => {
    const r = await store.stage({ name: 'a.md', dataBase64: b64('hi') });
    const found = await store.resolve(r.uploadId);
    assert.ok(found, '应能解析刚暂存的上传');
    assert.equal(found.name, 'a.md');
    assert.ok(existsSync(found.path));

    for (const bad of ['', '..', '../..', 'up-x', 'up-1/../../etc', null, undefined, 'UP-abc-12345678']) {
      assert.equal(await store.resolve(bad), null, `id=${JSON.stringify(bad)} 必须判为不可用`);
    }
    assert.equal(await store.resolve('up-zzzz-12345678'), null, '不存在的 id → null');
  });
});

test('discard：删除该次上传的暂存目录；未知 id → false', async () => {
  await withStore(async (store, root) => {
    const r = await store.stage({ name: 'a.md', dataBase64: b64('hi') });
    assert.equal(await store.discard(r.uploadId), true);
    assert.ok(!existsSync(join(root, 'uploads', r.uploadId)));
    assert.equal(await store.discard(r.uploadId), false);
    assert.equal(await store.discard('../evil'), false, '非法 id 不得触发删除');
  });
});

test('pruneStale：清理过期暂存（表单关掉没提交的上传不会永久占盘）', async () => {
  await withStore(async (store, root) => {
    const keep = await store.stage({ name: 'keep.md', dataBase64: b64('k') });
    const stale = await store.stage({ name: 'stale.md', dataBase64: b64('s') });
    // 把 stale 的目录 mtime 做旧
    const old = Date.now() - 48 * 60 * 60 * 1000;
    const { utimes } = await import('node:fs/promises');
    await utimes(join(root, 'uploads', stale.uploadId), old / 1000, old / 1000);

    const removed = await store.pruneStale();
    assert.equal(removed, 1, '应只清理过期的那一个');
    assert.ok(!existsSync(join(root, 'uploads', stale.uploadId)));
    assert.ok(existsSync(join(root, 'uploads', keep.uploadId)), '未过期的必须保留');
  });
});

test('pruneStale：暂存根不存在时返回 0（首次运行不报错）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-uploads-none-'));
  try {
    const store = new UploadStore(join(root, 'not-yet'));
    assert.equal(await store.pruneStale(), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pruneStale：跳过非 uploadId 形态的目录（不误删别人的东西）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knj-uploads-foreign-'));
  try {
    const dir = join(root, 'uploads');
    await mkdir(join(dir, 'someone-else'), { recursive: true });
    await writeFile(join(dir, 'someone-else', 'x.txt'), 'x');
    const store = new UploadStore(dir);
    assert.equal(await store.pruneStale(0), 0, '非 up-* 目录不得被清理');
    assert.ok(existsSync(join(dir, 'someone-else')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
