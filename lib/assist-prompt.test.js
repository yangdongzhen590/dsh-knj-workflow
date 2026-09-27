/**
 * dsh-knj-workflow AI 助手 prompt 组装单元测试（node:test，零依赖）
 * 运行：node --test lib/assist-prompt.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWorkflow, buildAssistPrompt, ASSIST_RULE_CARD } from './assist-prompt.js';

/** 样例工作流：串行 + XOR + human（覆盖摘要所需元素） */
function sampleWorkflow() {
  return {
    id: 'wf-demo', name: '演示流程', description: '一个演示',
    schemaVersion: 2, revision: 3,
    inputs: [],
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'analyze', type: 'task', title: '需求分析', inputs: [], body: { prompt: '分析需求', mode: 'single', output: { level: { type: 'string' } } } },
      { id: 'gw', type: 'gateway-xor', title: '复杂度分支' },
      { id: 'design', type: 'task', title: '设计', inputs: [], body: { prompt: '做设计', mode: 'single', output: {} } },
      { id: 'review', type: 'human', title: '人工评审', routes: [{ label: '通过', to: 'end' }, { label: '驳回', to: 'design' }] },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'analyze' },
      { from: 'analyze', to: 'gw' },
      { from: 'gw', to: 'design', when: { field: 'level', op: 'eq', value: 'high' } },
      { from: 'gw', to: 'review', default: true },
    ],
  };
}

// ---------------------------------------------------------------------------
// summarizeWorkflow
// ---------------------------------------------------------------------------
test('summarizeWorkflow: 包含节点 id/type/title', () => {
  const s = summarizeWorkflow(sampleWorkflow());
  assert.match(s, /wf-demo/);
  assert.match(s, /演示流程/);
  assert.match(s, /analyze/);
  assert.match(s, /需求分析/);
  assert.match(s, /task/);
});

test('summarizeWorkflow: 包含边的条件与默认标记', () => {
  const s = summarizeWorkflow(sampleWorkflow());
  assert.match(s, /level\s*==\s*high/);
  assert.match(s, /default/);
});

test('summarizeWorkflow: human 节点列出 routes', () => {
  const s = summarizeWorkflow(sampleWorkflow());
  assert.match(s, /通过/);
  assert.match(s, /驳回/);
  assert.match(s, /review/);
});

test('summarizeWorkflow: 缺 nodes/edges 时不抛错（空摘要）', () => {
  const s1 = summarizeWorkflow({ id: 'x', name: 'X' });
  assert.equal(typeof s1, 'string');
  const s2 = summarizeWorkflow(null);
  assert.equal(typeof s2, 'string');
});

test('summarizeWorkflow: 不泄露 x/y 坐标（布局无关，token 只给引用所需）', () => {
  const wf = sampleWorkflow();
  wf.nodes = wf.nodes.map((n, i) => ({ ...n, x: i * 100, y: 200 }));
  const s = summarizeWorkflow(wf);
  assert.ok(!/\bx[=:]\s*\d/.test(s), '摘要不应包含坐标');
});

// ---------------------------------------------------------------------------
// buildAssistPrompt
// ---------------------------------------------------------------------------
test('buildAssistPrompt: 包含角色、摘要、规则卡、消息', () => {
  const summary = summarizeWorkflow(sampleWorkflow());
  const p = buildAssistPrompt({ summary, history: [], message: '帮我加一个节点' });
  assert.match(p, /工作流/);
  assert.ok(p.includes(summary));
  assert.ok(p.includes('帮我加一个节点'));
});

test('buildAssistPrompt: 默认注入规则卡；显式 ruleCard 可覆盖', () => {
  const p1 = buildAssistPrompt({ summary: 'S', history: [], message: 'M' });
  assert.ok(p1.includes(ASSIST_RULE_CARD) || /add_node|add_edge|set_node/.test(p1));
  const p2 = buildAssistPrompt({ summary: 'S', history: [], message: 'M', ruleCard: '自定义规则' });
  assert.ok(p2.includes('自定义规则'));
  assert.ok(!p2.includes(ASSIST_RULE_CARD));
});

test('buildAssistPrompt: 历史并入且带角色前缀', () => {
  const history = [
    { role: 'user', content: '先加设计' },
    { role: 'assistant', content: '已加设计节点', edits: [{ action: 'add_node', type: 'task', id: 'design' }] },
  ];
  const p = buildAssistPrompt({ summary: 'S', history, message: '再加班' });
  assert.match(p, /先加设计/);
  assert.match(p, /已加设计节点/);
});

test('buildAssistPrompt: history 缺失/空数组不报错', () => {
  const p = buildAssistPrompt({ summary: 'S', message: 'M' });
  assert.equal(typeof p, 'string');
  assert.ok(p.length > 0);
});

test('buildAssistPrompt: 无 summary 时给出可读降级提示', () => {
  const p = buildAssistPrompt({ message: 'M' });
  assert.equal(typeof p, 'string');
});
