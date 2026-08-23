/**
 * dsh-knj-workflow 图工作流纯函数单元测试（node:test，零依赖）
 * 覆盖：图校验 validateWorkflow、网关路由 nextNode、数据流 resolveInputs
 * 运行：node --test lib/graph.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow, nextNode, resolveInputs, prepareWorkflowForSave } from './graph.js';

// 辅助：构造串行图
function serialWorkflow(over = {}) {
  return {
    id: 'wf-serial', name: '串行', schemaVersion: 2, revision: 1,
    inputs: [],
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: 'A', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'a' },
      { from: 'a', to: 'end' },
    ],
    ...over,
  };
}

// 辅助：构造带 XOR 网关的图（同 from→to 只有一条边：when 与 default 是同一条边的属性）
function xorWorkflow() {
  return {
    id: 'wf-xor', name: '分叉', schemaVersion: 2, revision: 1,
    inputs: [],
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'analyze', type: 'task', title: '分析', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'gw', type: 'gateway-xor', title: '复杂度' },
      { id: 'design', type: 'task', title: '设计', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'implement', type: 'task', title: '编码', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'analyze' },
      { from: 'analyze', to: 'gw' },
      { from: 'gw', to: 'design', when: { field: 'complexity', op: 'eq', value: 'high' }, default: true },
      { from: 'gw', to: 'implement', when: { field: 'complexity', op: 'eq', value: 'low' } },
      { from: 'design', to: 'end' },
      { from: 'implement', to: 'end' },
    ],
  };
}

// ---------------------------------------------------------------------------
// validateWorkflow
// ---------------------------------------------------------------------------
test('validateWorkflow: 合法串行图通过', () => {
  const r = validateWorkflow(serialWorkflow());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.errors, []);
});

test('validateWorkflow: 缺 start 报错', () => {
  const wf = serialWorkflow();
  wf.nodes = wf.nodes.filter((n) => n.type !== 'start');
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /start/.test(e)), JSON.stringify(r.errors));
});

test('validateWorkflow: 缺 end 报错', () => {
  const wf = serialWorkflow();
  wf.nodes = wf.nodes.filter((n) => n.type !== 'end');
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /end/.test(e)));
});

test('validateWorkflow: 两个 start 报错', () => {
  const wf = serialWorkflow();
  wf.nodes.push({ id: 'start2', type: 'start' });
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /start/.test(e)));
});

test('validateWorkflow: 节点 id 重复报错', () => {
  const wf = serialWorkflow();
  wf.nodes.push({ id: 'a', type: 'task', title: 'A2', inputs: [], body: { prompt: '', mode: 'single', output: {} } });
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /重复|duplicate|unique/.test(e)), JSON.stringify(r.errors));
});

test('validateWorkflow: 边指向不存在节点报错', () => {
  const wf = serialWorkflow();
  wf.edges.push({ from: 'a', to: 'ghost' });
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /ghost/.test(e)));
});

test('validateWorkflow: 孤立节点（非 start/end 无入边）报错', () => {
  const wf = serialWorkflow();
  wf.nodes.push({ id: 'orphan', type: 'task', title: '孤儿', inputs: [], body: { prompt: '', mode: 'single', output: {} } });
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /orphan/.test(e)));
});

test('validateWorkflow: 非法节点 type 报错', () => {
  const wf = serialWorkflow();
  wf.nodes.push({ id: 'x', type: 'bogus', title: 'X' });
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
});

test('validateWorkflow: XOR 网关无 default 边报错', () => {
  const wf = xorWorkflow();
  wf.edges = wf.edges.map((e) => (e.from === 'gw' ? { ...e, default: false } : e)); // 去掉所有 default 标记
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /default/.test(e)), JSON.stringify(r.errors));
});

test('validateWorkflow: XOR 网关有 default 边通过', () => {
  const r = validateWorkflow(xorWorkflow());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateWorkflow: 同 from→to 重复边报错', () => {
  const wf = xorWorkflow();
  wf.edges.push({ from: 'gw', to: 'design', default: true }); // gw→design 已存在
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /重复边/.test(e)), JSON.stringify(r.errors));
});

test('validateWorkflow: 多出边非默认边缺条件（死边）报错', () => {
  const wf = xorWorkflow();
  wf.edges = wf.edges.filter((e) => !(e.from === 'gw' && e.to === 'implement'));
  wf.edges.push({ from: 'gw', to: 'implement' }); // 无 when 非 default：永远不会命中
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /未配条件/.test(e)), JSON.stringify(r.errors));
});

test('validateWorkflow: task 多出边非默认边缺条件报错（与网关同一套语义）', () => {
  const wf = serialWorkflow();
  // a 改为多出边：a→end（无 when 非 default）+ a→b（default）
  wf.nodes.splice(2, 0, { id: 'b', type: 'task', title: 'B', inputs: [], body: { prompt: 'B', mode: 'single', output: {} } });
  wf.edges = [
    { from: 'start', to: 'a' },
    { from: 'a', to: 'end' },
    { from: 'a', to: 'b', default: true },
    { from: 'b', to: 'end' },
  ];
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /a .*未配条件/.test(e)), JSON.stringify(r.errors));
});

test('validateWorkflow: 人工节点放在并行分支内报错；join 之后合法', () => {
  // 图：split → [b1 → h(route→join), b2 → join] → c → end（h 在分支内 → 报错）
  const branchHuman = {
    id: 'wf-and-human', name: '并行含人工', schemaVersion: 2,
    inputs: [],
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'split', type: 'gateway-and', title: '分叉' },
      { id: 'b1', type: 'task', title: 'B1', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'h', type: 'human', title: '审批', routes: [{ label: '通过', to: 'join', tone: 'success' }] },
      { id: 'b2', type: 'task', title: 'B2', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'join', type: 'gateway-and', title: '汇合' },
      { id: 'c', type: 'task', title: 'C', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'split' },
      { from: 'split', to: 'b1' },
      { from: 'b1', to: 'h' },
      { from: 'split', to: 'b2' },
      { from: 'b2', to: 'join' },
      { from: 'join', to: 'c' },
      { from: 'c', to: 'end' },
    ],
  };
  const bad = validateWorkflow(branchHuman);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /不能放在并行分支内/.test(e)), JSON.stringify(bad.errors));

  // 图：join 之后接 human（join → h → end）→ 合法
  const afterJoin = {
    ...branchHuman,
    nodes: branchHuman.nodes.filter((n) => n.id !== 'h' && n.id !== 'c').concat([
      { id: 'h', type: 'human', title: '审批', routes: [{ label: '通过', to: 'end', tone: 'success' }] },
    ]),
    edges: [
      { from: 'start', to: 'split' },
      { from: 'split', to: 'b1' },
      { from: 'b1', to: 'join' },
      { from: 'split', to: 'b2' },
      { from: 'b2', to: 'join' },
      { from: 'join', to: 'h' },
    ],
  };
  const ok2 = validateWorkflow(afterJoin);
  assert.equal(ok2.ok, true, JSON.stringify(ok2.errors));
});

// ---------------------------------------------------------------------------
// nextNode（路由）
// ---------------------------------------------------------------------------
test('nextNode: 串行普通节点走唯一出边', () => {
  const wf = serialWorkflow();
  assert.equal(nextNode(wf, 'start', {}), 'a');
  assert.equal(nextNode(wf, 'a', {}), 'end');
});

test('nextNode: XOR 网关命中条件走对应分支', () => {
  const wf = xorWorkflow();
  // ctx 存上游节点输出；XOR 网关的 when.field 相对唯一上游（analyze）
  const ctx = { analyze: { complexity: 'high' } };
  assert.equal(nextNode(wf, 'gw', ctx), 'design');
  assert.equal(nextNode(wf, 'gw', { analyze: { complexity: 'low' } }), 'implement');
});

test('nextNode: XOR 网关条件都不命中走 default 边', () => {
  const wf = xorWorkflow();
  assert.equal(nextNode(wf, 'gw', { analyze: { complexity: 'medium' } }), 'design'); // default 指向 design
});

test('nextNode: XOR 网关无 default 且不命中抛错', () => {
  const wf = xorWorkflow();
  wf.edges = wf.edges.map((e) => ({ ...e, default: false }));
  assert.throws(() => nextNode(wf, 'gw', { analyze: { complexity: 'medium' } }), /default|no path/i);
});

test('nextNode: default 边带条件也参与匹配；兜底优先无条件 default', () => {
  // gw 三出边：design(when high)、b(default + when medium)、implement(default 无 when)
  const wf = xorWorkflow();
  wf.nodes.push({ id: 'b', type: 'task', title: '中等', inputs: [], body: { prompt: 'B', mode: 'single', output: {} } });
  wf.edges = [
    { from: 'start', to: 'analyze' },
    { from: 'analyze', to: 'gw' },
    { from: 'gw', to: 'design', when: { field: 'complexity', op: 'eq', value: 'high' } },
    { from: 'gw', to: 'b', when: { field: 'complexity', op: 'eq', value: 'medium' }, default: true },
    { from: 'gw', to: 'implement', default: true },
    { from: 'design', to: 'end' },
    { from: 'implement', to: 'end' },
    { from: 'b', to: 'end' },
  ];
  // medium：default 边的条件参与匹配并命中 → b
  assert.equal(nextNode(wf, 'gw', { analyze: { complexity: 'medium' } }), 'b');
  // high：普通条件命中 → design
  assert.equal(nextNode(wf, 'gw', { analyze: { complexity: 'high' } }), 'design');
  // 其他：兜底优先「无条件 default」→ implement（不被带条件的 default 抢走）
  assert.equal(nextNode(wf, 'gw', { analyze: { complexity: 'other' } }), 'implement');
});

test('nextNode: task 多出边按 when 条件路由（相对自身输出）', () => {
  const wf = serialWorkflow();
  wf.nodes.splice(2, 0, { id: 'b', type: 'task', title: 'B', inputs: [], body: { prompt: 'B', mode: 'single', output: {} } });
  wf.edges = [
    { from: 'start', to: 'a' },
    { from: 'a', to: 'end', when: { field: 'level', op: 'eq', value: 'ok' }, default: true },
    { from: 'a', to: 'b', when: { field: 'level', op: 'eq', value: 'bad' } },
    { from: 'b', to: 'end' },
  ];
  // a 自身输出 level=bad → b（条件相对自身输出，非上游）
  assert.equal(nextNode(wf, 'a', { a: { level: 'bad' } }), 'b');
  assert.equal(nextNode(wf, 'a', { a: { level: 'ok' } }), 'end');
  // 未命中 → 兜底 default（带条件的 default 兜底）→ end
  assert.equal(nextNode(wf, 'a', { a: { level: 'other' } }), 'end');
});

// ---------------------------------------------------------------------------
// resolveInputs（数据流：显式参数映射）
// ---------------------------------------------------------------------------
test('resolveInputs: 引用存在字段返回对应值', () => {
  const node = { id: 'b', type: 'task', inputs: [{ from: 'a', field: 'x' }] };
  const ctx = { a: { x: 1, y: 2 } };
  assert.deepEqual(resolveInputs(ctx, node), { a: { x: 1 } });
});

test('resolveInputs: field="*" 返回上游全部输出', () => {
  const node = { id: 'b', type: 'task', inputs: [{ from: 'a', field: '*' }] };
  const ctx = { a: { x: 1, y: 2 } };
  assert.deepEqual(resolveInputs(ctx, node), { a: { x: 1, y: 2 } });
});

test('resolveInputs: 引用不存在的字段抛错', () => {
  const node = { id: 'b', type: 'task', inputs: [{ from: 'a', field: 'missing' }] };
  const ctx = { a: { x: 1 } };
  assert.throws(() => resolveInputs(ctx, node), /missing/);
});

test('resolveInputs: 引用不存在的上游节点抛错', () => {
  const node = { id: 'b', type: 'task', inputs: [{ from: 'ghost', field: 'x' }] };
  const ctx = { a: { x: 1 } };
  assert.throws(() => resolveInputs(ctx, node), /ghost/);
});

test('resolveInputs: 无 inputs 返回空对象', () => {
  const node = { id: 'b', type: 'task', inputs: [] };
  assert.deepEqual(resolveInputs({}, node), {});
});

// ---------------------------------------------------------------------------
// prepareWorkflowForSave（保存前准备：校验 + revision 递增）
// ---------------------------------------------------------------------------
test('prepareWorkflowForSave: 首次保存 revision=1，再次递增', () => {
  const r1 = prepareWorkflowForSave(serialWorkflow(), null);
  assert.equal(r1.ok, true);
  assert.equal(r1.workflow.revision, 1);
  const r2 = prepareWorkflowForSave(serialWorkflow(), { revision: 3 });
  assert.equal(r2.workflow.revision, 4);
});

test('prepareWorkflowForSave: 非法图返回 errors', () => {
  const wf = serialWorkflow();
  wf.nodes = wf.nodes.filter((n) => n.type !== 'end');
  const r = prepareWorkflowForSave(wf, null);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test('prepareWorkflowForSave: 缺 id 返回错误', () => {
  const r = prepareWorkflowForSave({ nodes: [], edges: [] }, null);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /id/.test(e)));
});

test('validateWorkflow: human approveTo/rejectTo 目标（无 edges 入边）不报孤立', () => {
  const wf = {
    id: 'wf-human-end', nodes: [
      { id: 'start', type: 'start' },
      { id: 'verify', type: 'task', title: '验证', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'review', type: 'human', title: '评审', displayFrom: 'verify', approveTo: 'end', rejectTo: 'fix' },
      { id: 'fix', type: 'task', title: '修复', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'verify' },
      { from: 'verify', to: 'review' },
    ],
  };
  const r = validateWorkflow(wf);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateWorkflow: human 未配置通过/驳回去向 → 报错', () => {
  const wf = {
    id: 'wf-human-missing', nodes: [
      { id: 'start', type: 'start' },
      { id: 'verify', type: 'task', title: '验证', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'review', type: 'human', title: '设计评审', displayFrom: 'verify', approveTo: '', rejectTo: '' },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'verify' },
      { from: 'verify', to: 'review' },
    ],
  };
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('未配置任何去向')), JSON.stringify(r.errors));
});

test('validateWorkflow: human 多去向 routes 校验（目标无效 / 标签重复 / 缺标签）', () => {
  const wf = {
    id: 'wf-human-routes', nodes: [
      { id: 'start', type: 'start' },
      { id: 'verify', type: 'task', title: '验证', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'review', type: 'human', title: '设计评审', displayFrom: 'verify', routes: [
        { label: '通过', to: 'end' },
        { label: '驳回', to: 'nope' },       // 目标不存在
        { label: '驳回', to: 'end' },        // 标签重复
        { label: '', to: 'end' },            // 缺标签
      ] },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'verify' },
      { from: 'verify', to: 'review' },
    ],
  };
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('目标无效: nope')), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => e.includes('去向标签重复: 驳回')), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => e.includes('缺少标签')), JSON.stringify(r.errors));
});
