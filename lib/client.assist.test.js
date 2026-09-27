/**
 * dsh-knj-workflow AI 对话坞（Phase 3）测试（node:test，零依赖）
 * ---------------------------------------------------------------
 * 覆盖：
 *  - 纯函数 __test.assistDiff：AI 一轮改动的节点/边 diff（新增、修改、删除、边增删与条件变化）
 *  - 纯函数 __test.assistHistory：对话历史截断与角色映射（请求带上文用）
 *  - 源码结构断言：对话坞 DOM/类名、POST /assist 调用、整轮一次撤销（pushHistory）、
 *    画布 AI 改动高亮（绿虚线 + 角标）、「撤销本轮」绑定 undo、错误可见
 *
 * 运行：node --test lib/client.assist.test.js
 *
 * 说明：client.js 是浏览器 bundle（window.__ModuleLoader__.load 包装），与 client.io.test.js
 * 同一套 stub 手法加载；React 组件行为不在纯函数测试范围内，这里对产物源码做结构断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const src = readFileSync(join(import.meta.dirname, 'client.js'), 'utf8');

let loadedExports = null;
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
globalThis.document = { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {}, removeChild() {} } };
globalThis.Blob = class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } };
globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL() {} };

vm.runInThisContext(src, { filename: 'client.js' });

const __test = loadedExports.__test;

function wf() {
  return {
    id: 'wf', name: 'W', schemaVersion: 2, inputs: [],
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      { id: 'a', type: 'task', title: 'A', x: 100, y: 0, inputs: [], body: { prompt: '做 A', mode: 'single', output: {} } },
      { id: 'end', type: 'end', x: 200, y: 0 },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
  };
}

// ---------------------------------------------------------------------------
// assistDiff
// ---------------------------------------------------------------------------
test('assistDiff：新增节点与新增边被识别', () => {
  assert.equal(typeof __test.assistDiff, 'function', '__test 应暴露 assistDiff');
  const before = wf();
  const after = JSON.parse(JSON.stringify(before));
  after.nodes.splice(2, 0, { id: 'verify', type: 'task', title: '验证', x: 150, y: 0, inputs: [], body: { prompt: '', mode: 'single', output: {} } });
  after.edges = [{ from: 'start', to: 'a' }, { from: 'a', to: 'verify' }, { from: 'verify', to: 'end' }];
  const d = __test.assistDiff(before, after);
  assert.ok(d.nodes.includes('verify'), '新节点应出现在 diff.nodes');
  assert.ok(d.edges.includes('a->verify'), '新边应出现在 diff.edges');
  assert.ok(d.edges.includes('verify->end'));
});

test('assistDiff：节点属性变化被识别（改 prompt / 标题）', () => {
  const before = wf();
  const after = JSON.parse(JSON.stringify(before));
  after.nodes[1].body.prompt = '更严格地做 A';
  const d = __test.assistDiff(before, after);
  assert.ok(d.nodes.includes('a'), '内容变化的节点应被标为改动');
});

test('assistDiff：删除节点也计入改动（需重新布局/提示）', () => {
  const before = wf();
  const after = JSON.parse(JSON.stringify(before));
  after.nodes = after.nodes.filter((n) => n.id !== 'a');
  after.edges = after.edges.filter((e) => e.from !== 'a' && e.to !== 'a');
  const d = __test.assistDiff(before, after);
  assert.ok(d.nodes.includes('a'), '被删除的节点也应出现在 diff（画布需提示变化）');
});

test('assistDiff：边条件变化被识别；无变化图返回空 diff', () => {
  const before = wf();
  const same = JSON.parse(JSON.stringify(before));
  const d0 = __test.assistDiff(before, same);
  assert.deepEqual(d0.nodes, []);
  assert.deepEqual(d0.edges, []);

  const after = JSON.parse(JSON.stringify(before));
  after.edges[1] = { from: 'a', to: 'end', when: { field: 'passed', op: 'eq', value: true } };
  const d1 = __test.assistDiff(before, after);
  assert.ok(d1.edges.includes('a->end'), '条件变化的边应被标为改动');
});

test('assistDiff：入参缺失不抛错', () => {
  const d = __test.assistDiff(null, null);
  assert.deepEqual(d.nodes, []);
  assert.deepEqual(d.edges, []);
});

// ---------------------------------------------------------------------------
// assistHistory
// ---------------------------------------------------------------------------
test('assistHistory：角色映射与内容透传', () => {
  assert.equal(typeof __test.assistHistory, 'function', '__test 应暴露 assistHistory');
  const msgs = [
    { role: 'user', content: '加个验证节点' },
    { role: 'assistant', content: '已加', applied: [{ action: 'add_node' }], rejected: [] },
  ];
  const h = __test.assistHistory(msgs);
  assert.deepEqual(h, [
    { role: 'user', content: '加个验证节点' },
    { role: 'assistant', content: '已加' },
  ]);
});

test('assistHistory：只保留最近 N 条（默认 8）且丢弃错误项', () => {
  const msgs = [];
  for (let i = 0; i < 12; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
  const h = __test.assistHistory(msgs);
  assert.equal(h.length, 8, '默认只带最近 8 条，控制 token');
  assert.equal(h[h.length - 1].content, 'm11');
  assert.equal(h[0].content, 'm4');
});

test('assistHistory：空/非法输入返回空数组', () => {
  assert.deepEqual(__test.assistHistory([]), []);
  assert.deepEqual(__test.assistHistory(null), []);
});

// ---------------------------------------------------------------------------
// 源码结构断言（UI 与接线）
// ---------------------------------------------------------------------------
test('UI：编辑器含对话坞左右分栏结构（log / input）', () => {
  assert.match(src, /knj-assist-dock/, '应有对话坞容器类名');
  assert.match(src, /knj-assist-log/, '应有左侧对话过程区');
  assert.match(src, /knj-assist-input/, '应有右侧对话输入区');
  assert.match(src, /renderAssistDock\s*\(/, '应有 renderAssistDock 渲染函数');
});

test('UI：对话坞发送走 POST /assist 且带当前草稿与历史', () => {
  assert.match(src, /api\('\/assist',\s*\{[^}]*method:\s*'POST'/s, '应 POST /assist');
  assert.match(src, /body:\s*\{\s*workflow:\s*[^,]+,\s*message[^}]*history/s, '请求体应含 workflow / message / history');
  assert.match(src, /sendAssist\s*\(/, '应有 sendAssist 方法');
});

test('UI：AI 整轮改动作为一次撤销步（可整轮回退）', () => {
  // 应用返回草稿后入撤销栈：pushHistory(clone(nextWf)) 或 pushNow(nextWf)
  assert.match(src, /pushNow\(|pushHistory\(/, '应使用既有撤销栈机制');
  assert.match(src, /撤销本轮/, '动作卡应提供「撤销本轮」入口');
  assert.match(src, /undoAssistTurn|this\.undo\(\)/, '撤销本轮应回退整轮');
});

test('UI：画布高亮 AI 本轮改动节点（绿虚线 + 角标）', () => {
  assert.match(src, /assistChanged/, '应记录 AI 本轮改动 id');
  assert.match(src, /assistChanged[^\n]*includes\(n\.id\)|assistChanged\.includes/, 'renderNode 应按改动 id 高亮');
  assert.match(src, /#16a34a/, '高亮使用绿色（与动作卡成功色一致）');
  assert.match(src, /strokeDasharray[^\n]*5 3|strokeDasharray: '5 3'/, '高亮为虚线框');
});

test('UI：被拒动作在对话坞中明确展示原因（AI 犯错不静默）', () => {
  assert.match(src, /rejected/, '应消费 rejected');
  assert.match(src, /knj-assist-act-warn|knj-assist-act/, '应有动作卡样式');
});

test('UI：对话坞可收起（不占画布空间）且发送按钮在忙碌/空输入时禁用', () => {
  assert.match(src, /assistOpen/, '应有收起状态');
  assert.match(src, /assistBusy/, '应有忙碌状态');
  assert.match(src, /disabled:[^,}]*assistBusy/, '忙碌时应禁用发送');
});

// ---------------------------------------------------------------------------
// Phase 4：过程可见（异步启动 + 过程轮询 + 会话跳转）
// ---------------------------------------------------------------------------
test('UI：发送后走异步启动（requestId）并轮询 /assist/progress 显示过程', () => {
  assert.match(src, /requestId/, '应消费异步启动返回的 requestId');
  assert.match(src, /\/assist\/progress\?id=/, '应轮询过程端点');
  assert.match(src, /since=/, '轮询应带 since 增量参数');
  assert.match(src, /pollAssist/, '应有独立的轮询方法');
});

test('UI：过程行渲染（灰字步骤列表）并显示忙碌指示', () => {
  assert.match(src, /knj-assist-steps/, '应有过程行容器类名');
  assert.match(src, /knj-assist-step'/, '应有单条过程行类名');
  assert.match(src, /steps/, '助手消息应带过程步骤');
});

test('UI：过程轮询可被取消（组件卸载清理，不泄漏计时器）', () => {
  assert.match(src, /_assistCancelled/, '应有轮询取消标记');
  // 文件内多个组件都有 componentWillUnmount：必须找到含该标记的那一个（GraphEditor）
  const unmounts = [...src.matchAll(/componentWillUnmount\(\)\s*\{[\s\S]{0,400}?\n\t{2,4}\}/g)].map((m) => m[0]);
  assert.ok(unmounts.length > 0, '应存在 componentWillUnmount');
  assert.ok(unmounts.some((u) => /_assistCancelled/.test(u)), 'GraphEditor 卸载时应停止过程轮询');
});

test('UI：提供「查看助手完整会话」入口（跳 subagent 会话看完整思考过程）', () => {
  assert.match(src, /childId/, '应消费助手会话 id');
  assert.match(src, /viewAssistSession/, '应有会话跳转方法');
  assert.match(src, /sessions\.open\(childId\)/, '应复用 sessions.open 跳转');
  assert.match(src, /查看助手完整会话|查看会话/, '应有跳转按钮文案');
});

// ---------------------------------------------------------------------------
// Phase 5：过程信息量（渲染 sessionQuery 事件流：正文/推理/工具/用量）
// ---------------------------------------------------------------------------
test('UI：消费 progress.stream 快照并渲染实时正文 + 推理 + 工具卡片', () => {
  assert.match(src, /p\.stream/, '轮询结果应消费 stream 快照');
  assert.match(src, /knj-assist-stream/, '应有实时流容器');
  assert.match(src, /knj-assist-live/, '应渲染助手正文增量（流式文本）');
  assert.match(src, /knj-assist-reasoning/, '应渲染推理内容（灰字）');
  assert.match(src, /knj-assist-tool-|knj-assist-tools/, '应渲染工具调用卡片');
  assert.match(src, /tool-name|tool-args|tool-res/, '工具卡片应含名称/参数/结果');
});

test('UI：显示 token 用量（与原生对话同类的计量信息）', () => {
  assert.match(src, /stream\.usage/, '应读取 stream.usage');
  assert.match(src, /inputTokens|outputTokens/, '应显示输入/输出 token 数');
});

test('UI：等待期有流式光标指示（不是干等）', () => {
  assert.match(src, /caret/, '应有流式光标/进行中指示');
});

test('UI：结构化输出通道不作为工具卡片铺 JSON（其内容已作为正文流展示）', () => {
  assert.match(src, /isStructuredOutputTool/, '应有结构化输出识别辅助');
  assert.match(src, /structured_output/, '应识别 structured_output 工具名');
  assert.match(src, /filter\(\(t\) => !isStructuredOutputTool\(t\)\)/, '工具卡片应过滤结构化输出通道');
});

test('UI：对话坞提供「＋ 新对话」入口（清空对话、保留画布草稿）', () => {
  assert.match(src, /startNewAssistChat/, '应有新开对话方法');
  assert.match(src, /'＋ 新对话'/, '应渲染新对话按钮');
  const fn = src.match(/startNewAssistChat\(\)\s*\{[\s\S]{0,600}?\n\t{3}\}/);
  assert.ok(fn, '应能定位 startNewAssistChat 实现');
  assert.match(fn[0], /assistMessages:\s*\[\]/, '应清空对话消息');
  assert.ok(!/\bwf:/.test(fn[0]), '不应清空画布草稿（保留已应用改动，可 Ctrl+Z 回退）');
  assert.match(fn[0], /assistBusy/, '忙碌中应禁止新开');
});

// ---------------------------------------------------------------------------
// 回归：任务详情（调度器创建的任务缺 workflowSnapshot → 无流程图 / 到人工节点白屏）
// ---------------------------------------------------------------------------
test('UI：humanRoutes 对缺失节点容错（node 为 undefined 返回空数组，防详情白屏）', () => {
  const fn = src.match(/function humanRoutes\(node\)\s*\{[\s\S]{0,700}?\n\t{2}\}/);
  assert.ok(fn, '应能定位 humanRoutes 实现');
  assert.match(fn[0], /if \(!node \|\| typeof node !== 'object'\) return \[\];/,
    'humanRoutes 必须容错：snapshot 缺失时 humanRoutes(undefined) 抛 TypeError 会让详情整页空白');
});

test('UI：兜底快照有明确提示（按当前定义显示）', () => {
  assert.match(src, /workflowSnapshotFallback/, '应消费 fallback 标记');
  assert.match(src, /按当前定义显示|当前定义/, '应提示该图来自当前定义（任务创建时未存快照）');
});
