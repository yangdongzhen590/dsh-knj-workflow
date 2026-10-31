/**
 * /dev-task 命令注册契约（Host 端）回归测试（node:test，零依赖）
 * 覆盖：
 *  - 0.2.x 宿主契约：CommandDefinition 必须带 handler(invocation)，结果是 { kind, text }
 *  - 0.1.x 兼容：仍保留 execute(line) 与 { success, text }
 *  - 四个子命令的真实行为（new / list / status / wf）与错误分支
 * 运行：node --test lib/commands-contract.test.js
 *
 * 背景（现场）：插件曾只传 execute，而 0.2.1 的 dsh-commands.normalizeDefinition
 * 要求 handler 且缺失直接 throw TypeError，导致命令注册静默失败、/dev-task 不在菜单里。
 * 这个测试同时扮演两代宿主的校验器，任何一侧契约被破坏都会红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerCommands } from './index.js';

const ROOT = new URL('./', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** dsh-commands 0.2.x 的校验：handler 必填（缺失即 TypeError）；input 若声明则 hint 必须是非空字符串；
 *  返回形状 { kind, text }。逐条复刻宿主 normalizeDefinition（lib/index.js:149-165）。 */
function host02() {
  const defs = [];
  return {
    defs,
    register(def) {
      if (typeof def.handler !== 'function') {
        throw new TypeError(`command "${def.name}" handler must be a function`);
      }
      if (def.input !== undefined) {
        if (typeof def.input !== 'object' || def.input === null || typeof def.input.hint !== 'string') {
          throw new TypeError(`command "${def.name}" input hint must be a string`);
        }
        if (def.input.hint.trim().length === 0) {
          throw new TypeError(`command "${def.name}" input hint must not be empty`);
        }
      }
      defs.push(def);
      return () => {};
    },
  };
}

/** dsh-commands 0.1.x 的校验：execute 必填；返回形状 { success, text } */
function host01() {
  const defs = [];
  return {
    defs,
    register(def) {
      if (typeof def.execute !== 'function') {
        throw new TypeError(`command "${def.name}" execute must be a function`);
      }
      defs.push(def);
      return () => {};
    },
  };
}

function ctxWith(commands) {
  return {
    get: (name) => (name === 'commands' ? commands : undefined),
    effect: (fn) => { const d = fn(); return () => { try { d?.(); } catch {} }; },
  };
}

function makeStore({ tasks = [], workflows = [] } = {}) {
  const state = { saved: [], tasks: tasks.slice(), workflows: workflows.slice() };
  return {
    state,
    async listTasks() { return state.tasks.slice(); },
    async getTask(id) { return state.tasks.find((t) => t.id === id) ?? null; },
    async listWorkflows() { return state.workflows.slice(); },
    async saveTask(task) { state.saved.push(task); const i = state.tasks.findIndex((t) => t.id === task.id); if (i >= 0) state.tasks[i] = task; else state.tasks.push(task); },
    async mutateTask(id, fn) { const t = state.tasks.find((x) => x.id === id); if (t) { fn(t); } },
  };
}

const minimalWorkflow = {
  id: 'wf-test',
  name: '测试流程',
  nodes: [
    { id: 'start', type: 'start', inputs: [] },
    { id: 't1', type: 'task', title: '唯一阶段', inputs: [], body: { prompt: 'p', mode: 'single' } },
    { id: 'end', type: 'end', inputs: [] },
  ],
  edges: [{ from: 'start', to: 't1' }, { from: 't1', to: 'end' }],
};

function registerOn(commands, store, bridge = { startTask: async () => ({ runId: 'r1' }) }) {
  registerCommands(ctxWith(commands), store, bridge);
  return commands.defs[0];
}

test('0.2.x：按 handler(invocation) 契约注册，不再抛 TypeError', () => {
  const commands = host02();
  const store = makeStore({ workflows: [minimalWorkflow] });
  assert.doesNotThrow(() => registerCommands(ctxWith(commands), store, {}));
  assert.equal(commands.defs.length, 1);
  assert.equal(commands.defs[0].name, 'dev-task');
  assert.equal(typeof commands.defs[0].handler, 'function');
});

test('0.2.x：handler 接收 invocation 对象，返回 { kind: "success", text }', async () => {
  const commands = host02();
  const def = registerOn(commands, makeStore({ workflows: [minimalWorkflow] }), { startTask: async () => ({}) });
  const result = await def.handler({ rawInput: ' list', agent: {}, attachments: [], signal: undefined });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /暂无任务/);
});

test('命令必须声明 input.hint —— 否则客户端只接受裸命令，带参数的行会被当普通消息发给模型', async () => {
  const commands = host02();
  const def = registerOn(commands, makeStore({ workflows: [minimalWorkflow] }), {});
  assert.ok(def.input, 'CommandDefinition 必须带 input');
  assert.equal(typeof def.input.hint, 'string');
  assert.ok(def.input.hint.trim().length > 0, 'hint 不能为空（宿主会拒）');
  assert.match(def.input.hint, /list/, 'hint 要列出子命令');
});

test('handler 容错整行输入："/dev-task wf" 剥掉命令 token 后照常执行', async () => {
  const commands = host02();
  const def = registerOn(commands, makeStore({ workflows: [minimalWorkflow] }), {});
  for (const raw of ['/dev-task wf', 'dev-task wf', '  /dev-task   wf ']) {
    const r = await def.handler({ rawInput: raw });
    assert.equal(r.kind, 'success', raw);
    assert.match(r.text, /工作流（1）/, raw);
  }
});

test('空参数 → 返回用法（success，不该显示成失败）', async () => {
  const commands = host02();
  const def = registerOn(commands, makeStore({ workflows: [minimalWorkflow] }), {});
  for (const raw of ['', '   ', '/dev-task']) {
    const r = await def.handler({ rawInput: raw });
    assert.equal(r.kind, 'success', JSON.stringify(raw));
    assert.match(r.text, /用法/);
  }
});

test('0.1.x 兼容：execute(line) 仍可用，且返回 { success: true, text }', async () => {
  const commands = host01();
  const def = registerOn(commands, makeStore({ workflows: [minimalWorkflow] }), { startTask: async () => ({}) });
  assert.equal(typeof def.execute, 'function');
  const result = await def.execute('list');
  assert.equal(result.success, true);
  assert.match(result.text, /暂无任务/);
});

test('new：无标题 → error；有标题 → 建任务并启动', async () => {
  const commands = host02();
  const store = makeStore({ workflows: [minimalWorkflow] });
  const started = [];
  const def = registerOn(commands, store, { startTask: async (t) => { started.push(t.id); return {}; } });

  const bad = await def.handler({ rawInput: ' new' });
  assert.equal(bad.kind, 'error');
  assert.match(bad.text, /用法/);

  const ok = await def.handler({ rawInput: ' new 重构登录模块' });
  assert.equal(ok.kind, 'success');
  assert.match(ok.text, /已创建并启动任务/);
  assert.equal(started.length, 1);
  assert.equal(store.state.saved.at(-1).title, '重构登录模块');
  assert.equal(store.state.saved.at(-1).workflowId, 'wf-test');
});

test('new：启动失败 → 错误信息带出原因，任务落库为 failed', async () => {
  const commands = host02();
  const store = makeStore({ workflows: [minimalWorkflow] });
  const def = registerOn(commands, store, { startTask: async () => { throw new Error('engine down'); } });
  const result = await def.handler({ rawInput: ' new 任务A' });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /engine down/);
  assert.equal(store.state.tasks.at(-1).status, 'failed');
});

test('list / status / wf：真实输出形状；status 缺参报用法', async () => {
  const commands = host02();
  const store = makeStore({
    tasks: [{ id: 'task-a', title: '任务A', status: 'running', workflowId: 'wf-test', currentStage: '唯一阶段', stageStates: [{ id: 't1', title: '唯一阶段', status: 'running' }] }],
    workflows: [minimalWorkflow],
  });
  const def = registerOn(commands, store, {});

  const list = await def.handler({ rawInput: ' list' });
  assert.equal(list.kind, 'success');
  assert.match(list.text, /task-a/);
  assert.match(list.text, /running/);

  const noArg = await def.handler({ rawInput: ' status' });
  assert.equal(noArg.kind, 'error');

  const missing = await def.handler({ rawInput: ' status task-none' });
  assert.equal(missing.kind, 'error');
  assert.match(missing.text, /不存在/);

  const wf = await def.handler({ rawInput: ' wf' });
  assert.equal(wf.kind, 'success');
  assert.match(wf.text, /wf-test/);
  assert.match(wf.text, /1 个阶段/);

  const unknown = await def.handler({ rawInput: ' nope' });
  assert.equal(unknown.kind, 'error');
  assert.match(unknown.text, /未知子命令/);
});

test('注册用 ctx.effect 持有 disposer（卸载可注销，不残留旧 handler）', () => {
  const commands = host02();
  let disposer = null;
  const ctx = {
    get: (n) => (n === 'commands' ? commands : undefined),
    effect: (fn) => { const d = fn(); disposer = d; return () => {}; },
  };
  registerCommands(ctx, makeStore(), {});
  assert.equal(typeof disposer, 'function', 'register 的返回值必须被 ctx.effect 持有');
});

test('实现不得回退成只传 execute（源码守卫）', () => {
  const src = readFileSync(join(ROOT, 'index.js'), 'utf8');
  assert.match(src, /handler:\s*\(/, 'dev-task 定义必须提供 handler');
  assert.match(src, /execute:\s*\(/, '旧版 execute 兼容必须保留');
});
