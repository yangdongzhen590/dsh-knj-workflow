/**
 * dsh-knj-workflow 图工作流纯函数单元测试（node:test，零依赖）
 * 覆盖：图校验 validateWorkflow、网关路由 nextNode、数据流 resolveInputs
 * 运行：node --test lib/graph.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflow, nextNode, resolveInputs, prepareWorkflowForSave, orderTaskNodesByFlow } from './graph.js';

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

test('orderTaskNodesByFlow: 节点按拓扑执行顺序而非声明顺序（task11 声明在尾部但连线在中间）', () => {
  // 复现 wf-gate 实测：画布上先加了 task-2/task-3、后加 task11（nodes 声明序 task-1, task-2, task-3, task11），
  // 但连线是 start→task-1→task11→gw→(task-2|task-3)。stageStates 若按声明序生成会把 task11 排到最底，
  // 与真实执行顺序（task1→task11→task2/task3）不符。
  const wf = {
    id: 'wf-gate', schemaVersion: 2, revision: 2,
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'end', type: 'end' },
      { id: 'task-1', type: 'task', title: 'task-1' },
      { id: 'task-2', type: 'task', title: 'task-2' },
      { id: 'task-3', type: 'task', title: 'task-3' },
      { id: 'task11', type: 'task', title: 'task11' },
      { id: 'gw', type: 'gateway-xor' },
    ],
    edges: [
      { from: 'start', to: 'task-1' },
      { from: 'task-2', to: 'end' },
      { from: 'task-3', to: 'end' },
      { from: 'task-1', to: 'task11' },
      { from: 'task11', to: 'gw' },
      { from: 'gw', to: 'task-2' },
      { from: 'gw', to: 'task-3' },
    ],
  };
  const ordered = orderTaskNodesByFlow(wf);
  assert.deepEqual(ordered, ['task-1', 'task11', 'task-2', 'task-3'],
    `应按执行顺序排列，实际: ${JSON.stringify(ordered)}`);
});

test('orderTaskNodesByFlow: human 节点去向（routes）后的 task 参与拓扑排序', () => {
  const wf = {
    id: 'wf-human', schemaVersion: 2, revision: 1,
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'task-1', type: 'task', title: 'task-1' },
      { id: 'review', type: 'human', routes: [{ label: '通过', to: 'task-2' }, { label: '驳回', to: 'fix' }] },
      { id: 'task-2', type: 'task', title: 'task-2' },
      { id: 'fix', type: 'task', title: 'fix' },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'task-1' },
      { from: 'task-1', to: 'review' },
      { from: 'task-2', to: 'end' },
      { from: 'fix', to: 'task-2' }, // 驳回→fix→task-2（与 review 同层，BFS 先到为准）
    ],
  };
  const ordered = orderTaskNodesByFlow(wf);
  // start → task-1 → review(human) → task-2 与 fix；BFS 队列按邻接声明序先 task-2 后 fix
  assert.deepEqual(ordered, ['task-1', 'task-2', 'fix'],
    `human 后的 task 应继续排在拓扑序中，实际: ${JSON.stringify(ordered)}`);
});

// ---- 运行态图状态推导（deriveRunGraphStates：stageStates 缺失节点的状态补全）----
import { deriveRunGraphStates } from './graph.js';

function runWorkflow(over = {}) {
  return {
    id: 'wf-run', schemaVersion: 2, revision: 1,
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'task-1', type: 'task', title: 'task-1' },
      { id: 'gw', type: 'gateway-xor', title: '复杂度' },
      { id: 'human-1', type: 'human', routes: [{ label: '通过', to: 'task-2' }, { label: '不通过', to: 'task-3' }] },
      { id: 'task-2', type: 'task', title: 'task-2' },
      { id: 'task-3', type: 'task', title: 'task-3' },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'task-1' },
      { from: 'task-1', to: 'gw' },
      { from: 'gw', to: 'human-1' },
      { from: 'task-2', to: 'end' },
      { from: 'task-3', to: 'end' },
    ],
    ...over,
  };
}

test('deriveRunGraphStates: waiting-human 时 task-1 done、human 标 waiting、gw/start 已过、end 待执行', () => {
  const wf = runWorkflow();
  const stages = [
    { id: 'task-1', title: 'task-1', status: 'done', startedAt: '2026-09-02T23:31:04.435Z', finishedAt: '2026-09-02T23:34:18.386Z' },
    { id: 'task-2', title: 'task-2', status: 'pending' },
    { id: 'task-3', title: 'task-3', status: 'pending' },
  ];
  const task = { status: 'waiting-human', startedAt: '2026-09-02T23:31:03Z', humanState: { humanId: 'human-1', results: {} } };
  const st = deriveRunGraphStates(wf, stages, task);
  assert.equal(st['start'], 'passed');
  assert.equal(st['task-1'], 'done');
  assert.equal(st['gw'], 'passed', '网关后继已执行或待审 → 已过');
  assert.equal(st['human-1'], 'waiting');
  assert.equal(st['task-2'], 'pending');
  assert.equal(st['task-3'], 'pending');
  assert.equal(st['end'], 'pending');
});

test('deriveRunGraphStates: 任务 success 终态 → human 与 end 均 done', () => {
  const wf = runWorkflow();
  const stages = [
    { id: 'task-1', title: 'task-1', status: 'done' },
    { id: 'task-2', title: 'task-2', status: 'done' },
    { id: 'task-3', title: 'task-3', status: 'skipped' },
  ];
  const task = { status: 'success', startedAt: 'x', humanState: null };
  const st = deriveRunGraphStates(wf, stages, task);
  assert.equal(st['task-3'], 'skipped');
  assert.equal(st['human-1'], 'done');
  assert.equal(st['end'], 'done');
});

test('deriveRunGraphStates: 未启动任务全部为 pending，start 也未过', () => {
  const wf = runWorkflow();
  const task = { status: 'pending', startedAt: undefined, humanState: null };
  const st = deriveRunGraphStates(wf, [], task);
  assert.equal(st['start'], 'pending');
  assert.equal(st['task-1'], 'pending');
  assert.equal(st['human-1'], 'pending');
  assert.equal(st['end'], 'pending');
});

test('deriveRunGraphStates: 网关后继无任何已执行 → 网关仍 pending（分支未走）', () => {
  const wf = runWorkflow();
  const stages = [
    { id: 'task-1', title: 'task-1', status: 'done' },
    { id: 'task-2', title: 'task-2', status: 'pending' },
    { id: 'task-3', title: 'task-3', status: 'pending' },
  ];
  // human-1 未匹配 waiting、任务仍 running → 网关后继（human）非已执行态
  const task = { status: 'running', startedAt: 'x', humanState: null };
  const st = deriveRunGraphStates(wf, stages, task);
  assert.equal(st['gw'], 'pending');
});

// ---- 连线正交避让路由（routeEdge）----
import { routeEdge, routeEdgeKnee, smoothCurvePath } from './graph.js';

test('routeEdge: 同层无阻挡 → 单段水平线（无圆角）', () => {
  const r = routeEdge(200, 100, 800, 100, []);
  assert.equal(r.d, 'M 200 100 H 800');
  assert.equal(r.midY, 100);
});

test('routeEdgeKnee: 目标在下方、中间层有卡片 → 3 段骨架且竖列避开卡片', () => {
  // 源 (200,100)→(800,300)，中间卡 C(500,180) 半 62/24 → x 区间 438..562 拦在竖带内
  const k = routeEdgeKnee(200, 100, 800, 300, [{ x: 500, y: 180, hx: 62, hy: 24 }]);
  assert.equal(k.pts.length, 4, `应 3 段骨架: ${JSON.stringify(k.pts)}`);
  const X = k.pts[1][0];
  assert.ok(X < 438 || X > 562, `竖列 X=${X} 应避开中间卡（438..562）`);
});

test('routeEdgeKnee: 同层走廊被卡片堵死 → V-H-V 骨架（空闲带横穿）', () => {
  // 源 (200,100)→(800,100)，中间卡 C(500,100) 把 y=100 走廊整个截断
  const k = routeEdgeKnee(200, 100, 800, 100, [{ x: 500, y: 100, hx: 70, hy: 30 }]);
  assert.equal(k.pts.length, 4, `应 V-H-V 骨架: ${JSON.stringify(k.pts)}`);
  const y2 = k.pts[1][1];
  assert.equal(k.pts[1][0], 200, '源口先竖直离开（x 保持源端口）');
  assert.ok(Math.abs(y2 - 100) >= 60, `旁路带 y2=${y2} 应离开被堵走廊`);
});

test('routeEdgeKnee: 反向连线（源在目标右侧）同层被卡堵 → V-H-V 骨架仍成立', () => {
  const k = routeEdgeKnee(800, 100, 200, 100, [{ x: 500, y: 100, hx: 70, hy: 30 }]);
  assert.equal(k.pts.length, 4);
  const y2 = k.pts[1][1];
  assert.ok(Math.abs(y2 - 100) >= 60, `旁路带 y2=${y2} 应离开被堵走廊`);
  assert.equal(k.pts[0][0], 800, '起点仍为源端口');
});

test('smoothCurvePath: 避让骨架平滑为连续贝塞尔曲线（端口水平进出、无直线段/直角命令）', () => {
  const d = smoothCurvePath([[200, 100], [500, 100], [500, 300], [800, 300]]);
  assert.match(d, /^M 200 100 /);
  assert.match(d, / C /, '骨架之间应使用三次贝塞尔平滑');
  assert.ok(!/\bL\b/.test(d), '不应有直线段');
  assert.ok(!/\bQ\b|\bV\b|\bH\b/.test(d), '不应有直角/圆弧命令');
  assert.match(d, / 800 300$/, '终点精确落在目标端口');
});

test('routeEdge: 有避让时返回平滑曲线（含 C），直通保持水平线', () => {
  const r = routeEdge(200, 100, 800, 300, [{ x: 500, y: 180, hx: 62, hy: 24 }]);
  assert.match(r.d, / C /, `应含平滑曲线段: ${r.d}`);
  assert.equal(typeof r.midX, 'number');
  assert.equal(typeof r.midY, 'number');
});

test('routeEdge: 无障碍的异层连线 → 第一版优雅 S 贝塞尔（直接直连）', () => {
  const r = routeEdge(200, 100, 800, 300, []);
  assert.equal(r.d, 'M 200 100 C 500 100, 500 300, 800 300', '应保持最初版本 S 曲线观感');
  assert.equal(r.midY, 200);
});

test('routeEdge: 路径真正经过中间卡 → 避让；不在路径上的卡不触发绕行', () => {
  // 卡(500,180) 拦在 S 曲线中部 → 绕行；卡(880,60)（目标右上角远处）不挡 → 直连 S
  const blocked = routeEdge(200, 100, 800, 300, [{ x: 500, y: 180, hx: 62, hy: 24 }]);
  assert.notEqual(blocked.d, 'M 200 100 C 500 100, 500 300, 800 300');
  const free = routeEdge(200, 100, 800, 300, [{ x: 900, y: 40, hx: 62, hy: 24 }]);
  assert.equal(free.d, 'M 200 100 C 500 100, 500 300, 800 300', '远处卡不应触发绕行');
});
