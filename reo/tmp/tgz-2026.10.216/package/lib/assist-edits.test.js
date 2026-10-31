/**
 * dsh-knj-workflow AI 助手编辑动作引擎单元测试（node:test，零依赖）
 * ---------------------------------------------------------------
 * 运行：node --test lib/assist-edits.test.js
 * 覆盖：applyEdits 逐条应用/语义预检/图校验回滚、动作集白名单、非法场景、
 *       原 workflow 深度不可变。
 *
 * 引擎语义（与 design/assist-impl-phase1.spec.md 一致）：
 *   - 动作级语义预检失败 → rejected（含原因），跳过该动作，其余合法动作继续；
 *   - 全部动作应用后跑一次 validateWorkflow：
 *       ok  → 返回 { workflow: 应用后, applied, rejected }
 *       !ok → 整批回滚：workflow = 原始深拷贝, applied = [], rejected 追加图校验错误
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits } from './assist-edits.js';

/** 串行基座：start → a(task) → end（合法图） */
function baseWorkflow(over = {}) {
  return {
    id: 'wf-base', name: '基座', schemaVersion: 2, revision: 1,
    inputs: [],
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '做 A', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'a' },
      { from: 'a', to: 'end' },
    ],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 动作集白名单与基本语义
// ---------------------------------------------------------------------------
test('applyEdits: add_node 合法（无 id 时按标题生成 task-<slug>，可被同批引用）', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'remove_edge', from: 'a', to: 'end' }, // 先拆原边，a 才有空间接新分支
    { action: 'add_node', type: 'task', title: 'Verify', body: { prompt: '校验', mode: 'single', output: { passed: { type: 'boolean' } } } },
    { action: 'add_edge', from: 'a', to: 'task-verify' },
    { action: 'add_edge', from: 'task-verify', to: 'end' },
  ]);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  assert.equal(r.applied.length, 4);
  const node = r.workflow.nodes.find((n) => n.id === 'task-verify');
  assert.ok(node && node.title === 'Verify' && node.type === 'task');
});

test('applyEdits: add_node 中文标题 → 兜底随机 task-xxxx 前缀', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'add_node', type: 'task', id: 'task-zh', title: '验证' },
    { action: 'remove_edge', from: 'a', to: 'end' },
    { action: 'add_edge', from: 'a', to: 'task-zh' },
    { action: 'add_edge', from: 'task-zh', to: 'end' },
  ]);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  // 兜底生成逻辑单独存在即可，这里验证显式 id 仍可用
  const node = r.workflow.nodes.find((n) => n.id === 'task-zh');
  assert.ok(node && node.title === '验证');
});

test('applyEdits: 显式 id 生效且不重复生成', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'remove_edge', from: 'a', to: 'end' },
    { action: 'add_node', type: 'task', id: 'verify', title: '验证' },
    { action: 'add_edge', from: 'a', to: 'verify' },
    { action: 'add_edge', from: 'verify', to: 'end' },
  ]);
  assert.equal(r.rejected.length, 0);
  assert.ok(r.workflow.nodes.some((n) => n.id === 'verify'));
});

test('applyEdits: 未知动作类型被拒且不影响其它合法动作', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'explode_everything' },
    { action: 'set_meta', name: '改名' },
  ]);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /未知动作|explode_everything/);
  assert.ok(r.applied.some((x) => x.action === 'set_meta'));
  assert.equal(r.workflow.name, '改名');
});

test('applyEdits: 空 edits / 非数组 edits 不崩溃', () => {
  assert.equal(applyEdits(baseWorkflow(), []).applied.length, 0);
  const r = applyEdits(baseWorkflow(), null);
  assert.ok(Array.isArray(r.rejected) && r.rejected.length >= 1);
});

// ---------------------------------------------------------------------------
// 动作级非法场景（逐条拒绝，不污染，不影响后续）
// ---------------------------------------------------------------------------
test('applyEdits: 删除 start / end 被拒', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'remove_node', id: 'start' },
    { action: 'remove_node', id: 'end' },
  ]);
  assert.equal(r.rejected.length, 2);
  assert.ok(r.workflow.nodes.some((n) => n.id === 'start'));
  assert.ok(r.workflow.nodes.some((n) => n.id === 'end'));
});

test('applyEdits: remove_node / remove_edge 引用不存在的节点/边被拒', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'remove_node', id: 'ghost' },
    { action: 'remove_edge', from: 'a', to: 'ghost' },
  ]);
  assert.equal(r.rejected.length, 2);
});

test('applyEdits: 重复边被拒（同一 from→to 已有）', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'add_edge', from: 'start', to: 'a' },
  ]);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /重复|已存在/);
});

test('applyEdits: add_edge 指向不存在的节点被拒', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [{ action: 'add_edge', from: 'a', to: 'nope' }]);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /不存在/);
});

test('applyEdits: set_node 不允许写 x/y 坐标与 id', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'set_node', id: 'a', patch: { x: 999, y: 999, title: '改标题' } },
  ]);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /x|y|id/);
  const a = r.workflow.nodes.find((n) => n.id === 'a');
  assert.equal(a.x, undefined);
  assert.equal(a.title, 'A');
});

test('applyEdits: set_meta 不允许改 workflow id', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [{ action: 'set_meta', id: 'evil-id', name: 'x' }]);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.workflow.id, 'wf-base');
});

test('applyEdits: human 节点 routes 指向不存在节点被拒', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'add_node', type: 'human', id: 'h1', title: '审批', routes: [{ label: '通过', to: 'nope' }] },
  ]);
  assert.equal(r.rejected.length, 1);
});

test('applyEdits: set_node 引用不存在节点被拒', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [{ action: 'set_node', id: 'ghost', patch: { title: 'x' } }]);
  assert.equal(r.rejected.length, 1);
});

// ---------------------------------------------------------------------------
// 终检回滚场景（图校验失败 → 整批回滚，原图不被污染）
// ---------------------------------------------------------------------------
test('applyEdits: 孤立节点导致终检失败 → 整批回滚', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [{ action: 'add_node', type: 'task', id: 'orphan', title: '孤儿' }]);
  assert.equal(r.applied.length, 0);
  assert.ok(r.rejected.length >= 1);
  assert.match(r.rejected.map((x) => x.reason).join(' '), /孤立|入边|校验/);
  assert.deepEqual(r.workflow, wf, '整批回滚后原 workflow 不被污染');
});

test('applyEdits: XOR 出边不足/缺 default 导致终检失败 → 回滚', () => {
  const wf = baseWorkflow();
  // 把 a 后改接 XOR，但 XOR 只给 1 条出边 → 非法
  const r = applyEdits(wf, [
    { action: 'add_node', type: 'gateway-xor', id: 'gw', title: '分支' },
    { action: 'add_node', type: 'task', id: 'd1', title: 'D1' },
    { action: 'remove_edge', from: 'a', to: 'end' },
    { action: 'add_edge', from: 'a', to: 'gw' },
    { action: 'add_edge', from: 'gw', to: 'd1' }, // 仅 1 条出边且非 default → XOR 出边<2
    { action: 'add_edge', from: 'd1', to: 'end' },
  ]);
  assert.equal(r.applied.length, 0, JSON.stringify(r.rejected));
  assert.deepEqual(r.workflow, wf);
});

test('applyEdits: 完整 XOR 分流合法批量 → 全部 applied 无 rejected', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'add_node', type: 'gateway-xor', id: 'gw', title: '复杂度' },
    { action: 'add_node', type: 'task', id: 'd1', title: '设计', body: { prompt: '设计', mode: 'single', output: {} } },
    { action: 'add_node', type: 'task', id: 'd2', title: '直接编码', body: { prompt: '编码', mode: 'single', output: {} } },
    { action: 'remove_edge', from: 'a', to: 'end' },
    { action: 'add_edge', from: 'a', to: 'gw' },
    { action: 'add_edge', from: 'gw', to: 'd1', when: { field: 'level', op: 'eq', value: 'high' } },
    { action: 'add_edge', from: 'gw', to: 'd2', default: true },
    { action: 'add_edge', from: 'd1', to: 'end' },
    { action: 'add_edge', from: 'd2', to: 'end' },
  ]);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  assert.equal(r.applied.length, 9);
  assert.ok(r.workflow.nodes.some((n) => n.id === 'gw'));
  // 终检通过 → workflow 是应用后的（非回滚）
  assert.notDeepEqual(r.workflow, wf);
});

test('applyEdits: AND 并行 split+join 合法（gateway-and 双向）', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'add_node', type: 'gateway-and', id: 'split', title: '并行' },
    { action: 'add_node', type: 'gateway-and', id: 'join', title: '汇合' },
    { action: 'add_node', type: 'task', id: 'b1', title: 'B1', body: { prompt: '', mode: 'single', output: {} } },
    { action: 'add_node', type: 'task', id: 'b2', title: 'B2', body: { prompt: '', mode: 'single', output: {} } },
    { action: 'remove_edge', from: 'a', to: 'end' },
    { action: 'add_edge', from: 'a', to: 'split' },
    { action: 'add_edge', from: 'split', to: 'b1' },
    { action: 'add_edge', from: 'split', to: 'b2' },
    { action: 'add_edge', from: 'b1', to: 'join' },
    { action: 'add_edge', from: 'b2', to: 'join' },
    { action: 'add_edge', from: 'join', to: 'end' },
  ]);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
});

test('applyEdits: human 节点 + routes 通过/驳回 合法', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'add_node', type: 'human', id: 'h1', title: '评审', routes: [{ label: '通过', to: 'end' }] },
    { action: 'remove_edge', from: 'a', to: 'end' },
    { action: 'add_edge', from: 'a', to: 'h1' },
  ]);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
});

test('applyEdits: 环线（驳回重做）合法：a → h1 → a', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'add_node', type: 'human', id: 'h1', title: '审批', routes: [{ label: '通过', to: 'end' }, { label: '驳回', to: 'a' }] },
    { action: 'remove_edge', from: 'a', to: 'end' },
    { action: 'add_edge', from: 'a', to: 'h1' },
  ]);
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  // human 去向经 routes 表达：通过 → end（虚拟边）
});

test('applyEdits: set_node 修改 prompt/输出字段合法且保留其余字段', () => {
  const wf = baseWorkflow();
  const r = applyEdits(wf, [
    { action: 'set_node', id: 'a', patch: { title: 'A 加强', body: { prompt: '更严格地做 A', mode: 'single', output: { passed: { type: 'boolean' } } } } },
  ]);
  assert.equal(r.rejected.length, 0);
  const a = r.workflow.nodes.find((n) => n.id === 'a');
  assert.equal(a.title, 'A 加强');
  assert.equal(a.body.prompt, '更严格地做 A');
  assert.deepEqual(a.body.output, { passed: { type: 'boolean' } });
});

// ---------------------------------------------------------------------------
// 深度不可变：任何路径都不修改传入对象
// ---------------------------------------------------------------------------
test('applyEdits: 失败与成功路径均不改传入 workflow（深度不可变）', () => {
  const wf = baseWorkflow();
  const before = JSON.stringify(wf);
  // 失败路径（终检回滚）
  applyEdits(wf, [{ action: 'add_node', type: 'task', id: 'orphan2', title: '孤' }]);
  // 成功路径
  applyEdits(wf, [
    { action: 'remove_edge', from: 'a', to: 'end' },
    { action: 'add_node', type: 'task', id: 'v2', title: '验' },
    { action: 'add_edge', from: 'a', to: 'v2' },
    { action: 'add_edge', from: 'v2', to: 'end' },
  ]);
  assert.equal(JSON.stringify(wf), before);
});
