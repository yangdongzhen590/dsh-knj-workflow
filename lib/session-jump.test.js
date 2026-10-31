/**
 * 子会话跳转（任务详情节点「查看」/ AI 助手会话「查看」）的 DSH 版本适配单元测试（node:test，零依赖）
 *
 * 背景（真实故障）：DSH 0.2.x 移除了 `sessions.open()` 与 `sessions.refreshSubagents()`：
 *  - 导航 owner 改为 `ctx.uiWorkspace.openSession(target)`（target = SessionId | SubagentAddress）
 *  - 子会话目录/投影刷新改为 `ctx.sessions.refreshProjections(parentSessionId)`
 * 旧实现直接调旧 API，点「查看」只会得到 "sessions.refreshSubagents is not a function"。
 *
 * 覆盖：
 *  - openSessionById：新 API 优先（subagentAddress → uiWorkspace.openSession）
 *  - 子会话目录未就绪（subagentAddress 返回 undefined / 抛错）→ 回退裸 id
 *  - 旧版 DSH 回退 `sessions.open(id)`
 *  - 两个通道都不存在 → 抛可读错误（而不是 TypeError: xxx is not a function）
 *  - refreshSubagentCatalog：refreshProjections 优先、refreshSubagents 回退、都缺失返回 false
 *  - jumpToSubagentSession：首次 open 失败 → 刷新父会话投影后重试一次
 *
 * 运行：node --test lib/session-jump.test.js
 *
 * 说明：client.js 是浏览器 bundle（window.__ModuleLoader__.load 包装），
 * 这里沿用 client.io.test.js 的做法：stub window/document/URL/Blob/react，取 exports.__test 里的纯函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

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
  createElement: () => ({ click() {}, remove() {} }),
  body: { appendChild() {}, removeChild() {} },
};
globalThis.Blob = class {};
globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL() {} };

let loadedExports = null;
vm.runInThisContext(readFileSync(join(import.meta.dirname, 'client.js'), 'utf8'), { filename: 'client.js' });

const { openSessionById, refreshSubagentCatalog, jumpToSubagentSession, resolveSubagentTarget } = loadedExports.__test;

/** 0.2.x 的 sessions 服务（只有新 API；旧 API 刻意不存在——正是线上故障形态） */
function modernSessions(over = {}) {
  return {
    subagentAddress(id) {
      if (id !== 'child-1') return undefined;
      return { parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'one-shot' };
    },
    async refreshProjections() {},
    ...over,
  };
}

test('openSessionById：0.2.x 优先用 subagentAddress + uiWorkspace.openSession(target)', () => {
  const opened = [];
  const status = openSessionById(modernSessions(), { openSession: (t) => opened.push(t) }, 'child-1');
  assert.equal(status, 'uiWorkspace');
  assert.deepEqual(opened, [{ parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'one-shot' }],
    '有 subagentAddress 时必须把 durable address 交给原生跳转器，而不是裸 id');
});

test('openSessionById：subagentAddress 暂不可用（undefined）时回退裸 SessionId', () => {
  const opened = [];
  const status = openSessionById(modernSessions(), { openSession: (t) => opened.push(t) }, 'child-unknown');
  assert.equal(status, 'uiWorkspace');
  assert.deepEqual(opened, ['child-unknown']);
});

test('openSessionById：subagentAddress 自身抛错时不影响跳转（回退裸 id）', () => {
  const opened = [];
  const sessions = modernSessions({ subagentAddress() { throw new Error('catalog not ready'); } });
  assert.equal(openSessionById(sessions, { openSession: (t) => opened.push(t) }, 'child-1'), 'uiWorkspace');
  assert.deepEqual(opened, ['child-1']);
});

test('openSessionById：旧版 DSH（无 uiWorkspace）回退 sessions.open(id)', () => {
  const opened = [];
  const sessions = { open: (id) => opened.push(id) };
  assert.equal(openSessionById(sessions, null, 'child-1'), 'legacy');
  assert.deepEqual(opened, ['child-1']);
});

test('openSessionById：两个通道都缺失时抛可读错误，而不是 "is not a function"', () => {
  for (const [sessions, uiWorkspace] of [[{}, {}], [null, undefined], [modernSessions(), null]]) {
    assert.throws(() => openSessionById(sessions, uiWorkspace, 'child-1'), (err) => {
      assert.match(err.message, /不支持会话跳转/);
      assert.ok(!/is not a function/.test(err.message), '不得再把内部 API 缺失泄漏成 TypeError');
      return true;
    });
  }
});

test('openSessionById：缺 sessionId 时直接报参数错误', () => {
  assert.throws(() => openSessionById(modernSessions(), { openSession() {} }, ''), /缺少会话 id/);
});

test('refreshSubagentCatalog：0.2.x 用 refreshProjections(parentSessionId)', async () => {
  const seen = [];
  const sessions = { async refreshProjections(id) { seen.push(['projections', id]); } };
  assert.equal(await refreshSubagentCatalog(sessions, 'parent-1'), true);
  assert.deepEqual(seen, [['projections', 'parent-1']]);
});

test('refreshSubagentCatalog：0.1.x 回退 refreshSubagents(parentSessionId)', async () => {
  const seen = [];
  const sessions = { async refreshSubagents(id) { seen.push(['legacy', id]); } };
  assert.equal(await refreshSubagentCatalog(sessions, 'parent-1'), true);
  assert.deepEqual(seen, [['legacy', 'parent-1']]);
});

test('refreshSubagentCatalog：两个 API 都没有 → false（不抛 TypeError，不阻断跳转）', async () => {
  assert.equal(await refreshSubagentCatalog({}, 'parent-1'), false);
  assert.equal(await refreshSubagentCatalog(null, 'parent-1'), false);
  assert.equal(await refreshSubagentCatalog({ refreshProjections: async () => {} }, ''), false);
});

test('resolveSubagentTarget：目录查不到地址但知道父会话 → 合成 unknown 模式 address', () => {
  // 裸子会话 id 会被 sessions.retain 拒绝（"unknown session"），host 也要求 durable parent address；
  // 父会话关系已知时合成 {mode:'unknown'} 是唯一可用兜底（host 接受 unknown，再按子会话自身投影校验）。
  const target = resolveSubagentTarget(modernSessions(), 'child-unknown', 'parent-1');
  assert.deepEqual(target, { parentSessionId: 'parent-1', childSessionId: 'child-unknown', mode: 'unknown' });
});

test('resolveSubagentTarget：没有父会话信息时才回退裸 id（assist 路径无 parent 可用）', () => {
  assert.equal(resolveSubagentTarget(modernSessions(), 'child-unknown'), 'child-unknown');
});

test('jumpToSubagentSession：首次 open 失败 → 刷新父会话投影后重试成功', async () => {
  // 首次 open 时目录还没加载 → 原生侧抛错；刷新投影后 subagentAddress 才能解析出 address
  let catalogReady = false;
  const opened = [];
  const sessions = {
    subagentAddress(id) {
      if (!catalogReady) return undefined;
      return { parentSessionId: 'parent-1', childSessionId: id, mode: 'one-shot' };
    },
    async refreshProjections(id) { if (id === 'parent-1') catalogReady = true; },
  };
  const uiWorkspace = {
    openSession(target) {
      if (typeof target === 'string') throw new Error('unknown session');
      opened.push(target);
    },
  };
  const result = await jumpToSubagentSession(sessions, uiWorkspace, 'child-1', 'parent-1');
  assert.deepEqual(result, { refreshed: true, addressed: true });
  assert.deepEqual(opened, [{ parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'one-shot' }]);
});

test('jumpToSubagentSession：目录空且 refresh 空转（0.2.x state=ready 不重读）时，用合成 unknown address 跳转', async () => {
  const opened = [];
  const sessions = {
    subagentAddress() { return undefined; }, // 目录里始终没有
    async refreshProjections() {}, // 0.2.x 已 ready 时直接 return，不会补目录
  };
  const uiWorkspace = {
    openSession(target) {
      if (typeof target === 'string') throw new Error('sessions.retain: unknown session ' + target);
      opened.push(target);
    },
  };
  const result = await jumpToSubagentSession(sessions, uiWorkspace, 'child-1', 'parent-1');
  assert.deepEqual(opened, [{ parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'unknown' }]);
  // refreshed=true 只表示「尝试过刷新」（0.2.x ready 后是空转）；关键是有合成 address 兜底完成跳转
  assert.deepEqual(result, { refreshed: true, addressed: true });
});

test('jumpToSubagentSession：刷新投影抛错不覆盖首个错误，兜底仍会用合成 address 重试', async () => {
  const opened = [];
  const sessions = {
    subagentAddress() { return undefined; },
    async refreshProjections() { throw new Error('refresh rpc failed'); },
  };
  const uiWorkspace = { openSession(t) { if (typeof t === 'string') throw new Error('unknown'); opened.push(t); } };
  const result = await jumpToSubagentSession(sessions, uiWorkspace, 'child-1', 'parent-1');
  assert.equal(result.refreshed, false);
  assert.deepEqual(opened, [{ parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'unknown' }]);
});

test('jumpToSubagentSession：两种 target 都失败 → 抛最后一次错误（含原因），不静默吞掉', async () => {
  const sessions = { subagentAddress: () => undefined, refreshProjections: async () => {} };
  const uiWorkspace = { openSession(t) { throw new Error(typeof t === 'string' ? 'unknown session' : 'parent address rejected'); } };
  await assert.rejects(() => jumpToSubagentSession(sessions, uiWorkspace, 'child-1', 'parent-1'), /parent address rejected/);
});

test('源码接线：任务节点「查看」/ AI 助手「查看」都走版本适配助手，旧 API 只在能力探测后被调用', () => {
  const src = readFileSync(join(import.meta.dirname, 'client.js'), 'utf8');
  assert.match(src, /openSessionById\(/, '组件必须通过助手跳转');
  assert.match(src, /await refreshSubagentCatalog\(sessions, task\.parentSessionId\)/, '刷新父投影必须走适配助手');
  assert.match(src, /jumpToSubagentSession\(sessions, uiWorkspace, childId, task\.parentSessionId\)/, 'viewSubagent 必须走重试助手');
  assert.match(src, /uiWorkspace\.openSession\(resolveSubagentTarget\(sessions, sessionId, parentSessionId\)\)/, '0.2.x 必须经 uiWorkspace.openSession，且 target 优先 address、其次合成 unknown address');
  assert.match(src, /mode: 'unknown'/, '目录缺失时必须有合成 unknown address 的兜底');
  assert.match(src, /if \(typeof sessions\.refreshProjections === 'function'\)/, '必须能力探测 refreshProjections');
  assert.match(src, /if \(typeof sessions\.refreshSubagents === 'function'\) \{\s*await sessions\.refreshSubagents\(/, '旧 refreshSubagents 只能出现在能力探测分支里');
  assert.ok(!/await sessions\.refreshSubagents\(task\.parentSessionId\)/.test(src), '组件里不得再直连旧 API（0.2.x 会 TypeError）');
  assert.ok(!/^\s*sessions\.open\(childId\);$/m.test(src), '不得再无条件 sessions.open（0.2.x 已移除）');
});
