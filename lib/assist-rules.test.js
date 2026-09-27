/**
 * dsh-knj-workflow 流程配置规范（assist-rules）测试（node:test，零依赖）
 * ---------------------------------------------------------------
 * 两类断言：
 *   A. 规范内容完整性：分节齐全、关键条款字样存在（防误删）
 *   B. 与实现一致性：规范自称的每条"硬约束"，都必须能被 validateWorkflow 真实拦下
 *      （防止规范与校验器漂移——规范写错比不写更危险）
 *
 * 运行：node --test lib/assist-rules.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSIST_RULES, ASSIST_RULES_SECTIONS } from './assist-rules.js';
import { validateWorkflow } from './graph.js';

/** 合法基座：start → a(task) → end */
function base(over = {}) {
  return {
    id: 'wf', name: 'W', schemaVersion: 2, inputs: [],
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '做 A', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A. 规范内容完整性
// ---------------------------------------------------------------------------
test('规范：分节齐全（图形态/节点/边/网关/人工/数据流/运行/反模式）', () => {
  assert.ok(Array.isArray(ASSIST_RULES_SECTIONS) && ASSIST_RULES_SECTIONS.length >= 8, '规范应有 ≥8 个分节');
  const titles = ASSIST_RULES_SECTIONS.map((s) => s.title).join('|');
  for (const kw of ['图', '节点', '边', '网关', '人工', '引用', '运行', '反模式']) {
    assert.match(titles, new RegExp(kw), `规范应含「${kw}」相关分节（现有：${titles}）`);
  }
  assert.ok(ASSIST_RULES.length > 800, `规范正文应有实质内容（当前 ${ASSIST_RULES.length} 字）`);
});

test('规范：覆盖用户最易踩的坑（死边/孤立/XOR default/并行内 human/嵌套并行/maxRuns）', () => {
  for (const kw of [
    'default', '孤立', '永不命中', '并行', 'maxRuns', '嵌套',
  ]) {
    assert.ok(ASSIST_RULES.includes(kw), `规范应提到「${kw}」`);
  }
  // human 节点在本插件里的正式名是「人工审批」/human
  assert.match(ASSIST_RULES, /人工审批|human/, '规范应提到人工审批节点');
  assert.match(ASSIST_RULES, /不要把 human 放进并行分支内|并行分支内不能放 human/, '规范应明确禁止 human 进并行分支');
});

test('规范：给出引用语法与输出字段类型要求', () => {
  for (const kw of ['${inputDescription}', '${inputTitle}', '${taskId}', '${inputs.', 'boolean', 'array']) {
    assert.ok(ASSIST_RULES.includes(kw), `规范应含引用/类型线索「${kw}」`);
  }
});

test('规范：明确 prompt 不应要求执行构建/测试（防子 agent 挂起）', () => {
  assert.match(ASSIST_RULES, /构建|编译|测试/, '应提到构建/测试相关约束');
  assert.match(ASSIST_RULES, /不要|避免|勿/, '应给出明确的禁止语气');
});

// ---------------------------------------------------------------------------
// B. 与实现一致性：规范自称的硬约束必须能被 validateWorkflow 拦下
// ---------------------------------------------------------------------------
test('一致性：start/end 缺失会被拦（规范声称必须有且仅有一个）', () => {
  const noEnd = base({ edges: [{ from: 'start', to: 'a' }], nodes: base().nodes.filter((n) => n.id !== 'end') });
  assert.equal(validateWorkflow(noEnd).ok, false);
  const noStart = base({ edges: [{ from: 'a', to: 'end' }], nodes: base().nodes.filter((n) => n.id !== 'start') });
  assert.equal(validateWorkflow(noStart).ok, false);
});

test('一致性：孤立节点会被拦（规范声称除 start 外都要有入边）', () => {
  const wf = base();
  wf.nodes.push({ id: 'orphan', type: 'task', title: '孤儿', inputs: [], body: { prompt: '', mode: 'single', output: {} } });
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /孤立|入边/);
});

test('一致性：重复边会被拦（规范声称同一对节点只能一条边）', () => {
  const wf = base({ edges: [{ from: 'start', to: 'a' }, { from: 'start', to: 'a' }, { from: 'a', to: 'end' }] });
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /重复边/);
});

test('一致性：XOR 出边不足 / 缺 default / 存在永不命中的死边 会被拦', () => {
  const mk = (edges) => base({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'gw', type: 'gateway-xor', title: 'G' },
      { id: 'd1', type: 'task', title: 'D1', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'd2', type: 'task', title: 'D2', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges,
  });
  // 出边不足（1 条）
  assert.equal(validateWorkflow(mk([
    { from: 'start', to: 'gw' }, { from: 'gw', to: 'd1' }, { from: 'd1', to: 'end' },
  ])).ok, false);
  // 出边 ≥2 但无 default
  const noDefault = validateWorkflow(mk([
    { from: 'start', to: 'gw' },
    { from: 'gw', to: 'd1', when: { field: 'level', op: 'eq', value: 'high' } },
    { from: 'gw', to: 'd2', when: { field: 'level', op: 'eq', value: 'low' } },
    { from: 'd1', to: 'end' }, { from: 'd2', to: 'end' },
  ]));
  assert.equal(noDefault.ok, false);
  assert.match(noDefault.errors.join(' '), /default/);
  // 非默认边未配条件（永不命中）
  const dead = validateWorkflow(mk([
    { from: 'start', to: 'gw' },
    { from: 'gw', to: 'd1' },
    { from: 'gw', to: 'd2', default: true },
    { from: 'd1', to: 'end' }, { from: 'd2', to: 'end' },
  ]));
  assert.equal(dead.ok, false);
  assert.match(dead.errors.join(' '), /永不命中|未配条件/);
});

test('一致性：task 多出边的非默认边未配条件会被拦（规范对 task 与 XOR 一视同仁）', () => {
  const wf = base({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'b', type: 'task', title: 'B', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'a', to: 'end', default: true },
      { from: 'b', to: 'end' },
    ],
  });
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /永不命中|未配条件/);
});

test('一致性：human 无去向 / 标签重复 / 目标无效 会被拦', () => {
  const mk = (node) => base({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'h', type: 'human', title: '审批', ...node },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'h' }],
  });
  assert.equal(validateWorkflow(mk({})).ok, false, '无去向应被拦');
  const dup = validateWorkflow(mk({ routes: [{ label: '通过', to: 'end' }, { label: '通过', to: 'end' }] }));
  assert.equal(dup.ok, false);
  assert.match(dup.errors.join(' '), /重复|标签/);
  const badTarget = validateWorkflow(mk({ routes: [{ label: '通过', to: 'nope' }] }));
  assert.equal(badTarget.ok, false);
  assert.match(badTarget.errors.join(' '), /目标无效|不存在/);
});

test('一致性：AND 网关拓扑非法（既非 split 也非 join）会被拦', () => {
  const wf = base({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'g', type: 'gateway-and', title: '并行' },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'g' }, { from: 'g', to: 'end' }],
  });
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /并行网关|split|join/);
});

test('一致性：human 放在并行分支内会被拦（规范明确禁止）', () => {
  const wf = base({
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'split', type: 'gateway-and', title: '并行' },
      { id: 'b1', type: 'task', title: 'B1', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'h', type: 'human', title: '分支内审批', routes: [{ label: '通过', to: 'join' }] },
      { id: 'join', type: 'gateway-and', title: '汇合' },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'split' },
      { from: 'split', to: 'b1' },
      { from: 'split', to: 'h' },
      { from: 'b1', to: 'join' },
      { from: 'join', to: 'end' },
    ],
  });
  const r = validateWorkflow(wf);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /并行分支|人工节点/);
});
