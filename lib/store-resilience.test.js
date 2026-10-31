/**
 * 持久化健壮性回归测试（node:test，零依赖）
 * 覆盖：
 *  - workflows.json 损坏 → 隔离为 workflows.json.corrupt-<ts>，启动不崩、仍注入默认工作流
 *  - task.json 损坏 → 隔离并跳过，不影响其它任务
 *  - task.json 带 UTF-8 BOM → 仍能解析（不再静默消失）
 * 运行：node --test lib/store-resilience.test.js
 *
 * 背景（现场）：readJson 曾对任何异常静默 return fallback；init() 见 workflows 为空就注入
 * 默认工作流并写回。一次手改错逗号 = 全部工作流被默认流水线覆盖，且无备份、无告警。
 * 另外真实数据里有 1 个 task.json 带 BOM，朴素 JSON.parse 直接失败 → 任务在列表里静默消失。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevTaskStore } from './index.js';

async function tmpRoot() {
  return await mkdtemp(join(tmpdir(), 'knj-store-'));
}

async function writeTask(root, id, value, { raw } = {}) {
  const dir = join(root, 'tasks', id);
  await mkdir(dir, { recursive: true });
  const body = raw !== undefined ? raw : JSON.stringify(value);
  await writeFile(join(dir, 'task.json'), body, 'utf8');
  return dir;
}

test('workflows.json 损坏 → 隔离为 .corrupt-<ts>，启动不崩且仍有默认工作流', async () => {
  const root = await tmpRoot();
  try {
    // 典型手改事故：多一个逗号
    await writeFile(join(root, 'workflows.json'), '{ "workflows": [ { "id": "wf-x",, } ] }', 'utf8');
    const store = new DevTaskStore(root);
    await store.init(); // 不得抛错

    const list = await store.listWorkflows();
    assert.ok(Array.isArray(list) && list.length >= 1, '损坏后仍要有可用工作流（默认种子）');

    const entries = await readdir(root);
    const quarantined = entries.filter((n) => n.startsWith('workflows.json.corrupt-'));
    assert.equal(quarantined.length, 1, '损坏文件必须被改名保留（可人工恢复）');
    assert.equal(entries.includes('workflows.json'), true, '新文件仍要就位（默认工作流已写回）');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task.json 损坏 → 隔离并跳过该任务，不影响其它任务', async () => {
  const root = await tmpRoot();
  try {
    await writeFile(join(root, 'workflows.json'), JSON.stringify({ workflows: [] }), 'utf8');
    const badDir = await writeTask(root, 'task-bad', null, { raw: '{ "id": "task-bad", ' });
    await writeTask(root, 'task-ok', { id: 'task-ok', title: '好任务', status: 'success', createdAt: '2026-01-01T00:00:00.000Z' });

    const store = new DevTaskStore(root);
    await store.init();
    const list = await store.listTasks();

    assert.deepEqual(list.map((t) => t.id), ['task-ok']);
    const badFiles = await readdir(badDir);
    assert.ok(badFiles.some((n) => n.startsWith('task.json.corrupt-')), '损坏的 task.json 必须被隔离而不是留在原地被后续写覆盖');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task.json 带 UTF-8 BOM → 仍能解析（真实数据里出现过 1 例）', async () => {
  const root = await tmpRoot();
  try {
    await writeFile(join(root, 'workflows.json'), JSON.stringify({ workflows: [] }), 'utf8');
    const task = { id: 'task-bom', title: 'BOM 任务', status: 'success', createdAt: '2026-02-02T00:00:00.000Z' };
    await writeTask(root, 'task-bom', null, { raw: '\uFEFF' + JSON.stringify(task) });

    const store = new DevTaskStore(root);
    await store.init();
    const list = await store.listTasks();
    assert.deepEqual(list.map((t) => t.id), ['task-bom'], 'BOM 不该让任务静默消失');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('文件不存在 ≠ 损坏：首次启动不产生 .corrupt 文件', async () => {
  const root = await tmpRoot();
  try {
    const store = new DevTaskStore(root);
    await store.init();
    const entries = await readdir(root);
    assert.equal(entries.some((n) => n.includes('.corrupt-')), false);
    assert.ok((await store.listWorkflows()).length >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
