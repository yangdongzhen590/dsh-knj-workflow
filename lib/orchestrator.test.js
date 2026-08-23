/**
 * dsh-knj-workflow 图编排器测试（node:test）
 * 用 vm 沙箱执行 orchestrator.js，mock 引擎的 agent/phase/log，验证图遍历顺序。
 * 运行：node --test lib/orchestrator.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('./orchestrator.js', import.meta.url), 'utf8');

/**
 * 在 vm 沙箱里执行编排器脚本，返回 { result, agentCalls, phaseCalls }。
 * agentImpl(label, prompt) 按节点 title 返回该 task 节点的输出。
 */
async function runOrchestrator(workflow, agentImpl, extraArgs = {}) {
  const agentCalls = [];
  const phaseCalls = [];
  const logCalls = [];
  const sandbox = {
    args: { config: workflow, task: { id: 't1', title: 'T', taskDir: '.tasks/t1' }, ...extraArgs },
    agent: async (prompt, opts) => {
      agentCalls.push(opts?.label ?? '?');
      return agentImpl ? agentImpl(opts?.label, prompt) : { ok: true };
    },
    parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    phase: (title) => { phaseCalls.push(title); },
    log: (message) => { logCalls.push(message); },
    console,
  };
  const wrapped = `(async () => {\n${code}\n})()`;
  try {
    const result = await vm.runInNewContext(wrapped, sandbox, { timeout: 5000 });
    return { result, agentCalls, phaseCalls, logCalls };
  } catch (e) {
    // orchestrator 执行失败（节点 subagent 无输出 / 并行分支失败 / 循环超限）→ 返回失败结果
    return { result: { ok: false, error: e instanceof Error ? e.message : String(e) }, agentCalls, phaseCalls, logCalls };
  }
}

test('orchestrator: 串行图按序执行 task 节点', async () => {
  const wf = {
    id: 'wf', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: 'A', mode: 'single', output: {} } },
      { id: 'b', type: 'task', title: 'B', inputs: [{ from: 'a', field: '*' }], body: { prompt: 'B', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'end' }],
  };
  const { result, agentCalls } = await runOrchestrator(wf, (label) => ({ label, ok: true }));
  assert.deepEqual(agentCalls, ['A', 'B']);
  assert.equal(result.current, 'end');
  assert.ok(result.results.a);
  assert.ok(result.results.b);
});

test('orchestrator: prompt 用 ${ctx.a.x} 显式引用上游输出', async () => {
  const wf = {
    id: 'wf', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: 'A', mode: 'single', output: {} } },
      { id: 'b', type: 'task', title: 'B', inputs: [], body: { prompt: '上游 x=${ctx.a.x}，y=${ctx.a.y}', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'end' }],
  };
  let capturedPrompt = null;
  await runOrchestrator(wf, (label, prompt) => {
    if (label === 'A') return { x: 42, y: 99 };
    if (label === 'B') { capturedPrompt = prompt; return { ok: true }; }
    return { ok: true };
  });
  // 显式引用 ${ctx.a.x} / ${ctx.a.y} 生效；未引用的内容不注入
  assert.ok(capturedPrompt.includes('上游 x=42'), capturedPrompt);
  assert.ok(capturedPrompt.includes('y=99'), capturedPrompt);
});

test('orchestrator: XOR 网关走 high 分支（跳过 low 分支）', async () => {
  const wf = {
    id: 'wf', nodes: [
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
      { from: 'gw', to: 'design', when: { field: 'complexity', op: 'eq', value: 'high' } },
      { from: 'gw', to: 'implement', when: { field: 'complexity', op: 'eq', value: 'low' } },
      { from: 'gw', to: 'design', default: true },
      { from: 'design', to: 'end' },
      { from: 'implement', to: 'end' },
    ],
  };
  const { result, agentCalls } = await runOrchestrator(wf, (label) => {
    if (label === '分析') return { complexity: 'high' };
    return { ok: true };
  });
  assert.ok(agentCalls.includes('设计'), JSON.stringify(agentCalls));
  assert.ok(!agentCalls.includes('编码'), JSON.stringify(agentCalls));
  assert.equal(result.current, 'end');
});

test('orchestrator: XOR 网关条件不命中走 default', async () => {
  const wf = {
    id: 'wf', nodes: [
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
      { from: 'gw', to: 'design', when: { field: 'complexity', op: 'eq', value: 'high' } },
      { from: 'gw', to: 'implement', when: { field: 'complexity', op: 'eq', value: 'low' } },
      { from: 'gw', to: 'design', default: true },
      { from: 'design', to: 'end' },
      { from: 'implement', to: 'end' },
    ],
  };
  const { agentCalls } = await runOrchestrator(wf, (label) => {
    if (label === '分析') return { complexity: 'medium' }; // 不命中
    return { ok: true };
  });
  assert.ok(agentCalls.includes('设计'), JSON.stringify(agentCalls)); // default 指向 design
  assert.ok(!agentCalls.includes('编码'));
});

test('orchestrator: default 边带条件也参与匹配；兜底优先无条件 default', async () => {
  const wf = {
    id: 'wf', nodes: [
      { id: 'start', type: 'start' },
      { id: 'analyze', type: 'task', title: '分析', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'gw', type: 'gateway-xor', title: '复杂度' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'b', type: 'task', title: 'B', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'c', type: 'task', title: 'C', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'analyze' },
      { from: 'analyze', to: 'gw' },
      { from: 'gw', to: 'a', when: { field: 'level', op: 'eq', value: 'high' } },
      { from: 'gw', to: 'b', when: { field: 'level', op: 'eq', value: 'medium' }, default: true }, // default 带条件
      { from: 'gw', to: 'c', default: true }, // 无条件兜底
      { from: 'a', to: 'end' }, { from: 'b', to: 'end' }, { from: 'c', to: 'end' },
    ],
  };
  // level=medium → default 边的条件命中 → B
  const r1 = await runOrchestrator(wf, (label) => (label === '分析' ? { level: 'medium' } : { ok: true }));
  assert.ok(r1.agentCalls.includes('B'), JSON.stringify(r1.agentCalls));
  assert.ok(!r1.agentCalls.includes('C'), JSON.stringify(r1.agentCalls));
  // level=other → 无条件 default 兜底 → C（不会被带条件的 default 抢走）
  const r2 = await runOrchestrator(wf, (label) => (label === '分析' ? { level: 'other' } : { ok: true }));
  assert.ok(r2.agentCalls.includes('C'), JSON.stringify(r2.agentCalls));
  assert.ok(!r2.agentCalls.includes('B'), JSON.stringify(r2.agentCalls));
});

test('orchestrator: 条件字段支持 ${节点id.字段} 显式引用（布尔原始值比较）', async () => {
  const wf = {
    id: 'wf', nodes: [
      { id: 'start', type: 'start' },
      { id: 't1', type: 'task', title: 'T1', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 't2', type: 'task', title: 'T2', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'gw', type: 'gateway-xor', title: '按 T1 判断' },
      { id: 'yes', type: 'task', title: '是', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'no', type: 'task', title: '否', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 't1' },
      { from: 't1', to: 't2' }, // 网关的直接上游是 t2，但条件引用的是 t1 的输出
      { from: 't2', to: 'gw' },
      { from: 'gw', to: 'yes', when: { field: '${t1.passed}', op: 'eq', value: true } },
      { from: 'gw', to: 'no', default: true },
      { from: 'yes', to: 'end' }, { from: 'no', to: 'end' },
    ],
  };
  // t1 输出布尔 passed=true（注意 gw 的直接上游 t2 没有 passed 字段——裸字段名取不到，必须用 ${}）
  const r1 = await runOrchestrator(wf, (label) => (label === 'T1' ? { passed: true } : { ok: true }));
  assert.ok(r1.agentCalls.includes('是'), JSON.stringify(r1.agentCalls));
  assert.ok(!r1.agentCalls.includes('否'), JSON.stringify(r1.agentCalls));
  const r2 = await runOrchestrator(wf, (label) => (label === 'T1' ? { passed: false } : { ok: true }));
  assert.ok(r2.agentCalls.includes('否'), JSON.stringify(r2.agentCalls));
});

test('orchestrator: 条件值字符串宽松匹配旧配置（"true" 匹配布尔 true / "5" 匹配数字 5）', async () => {
  const wf = {
    id: 'wf', nodes: [
      { id: 'start', type: 'start' },
      { id: 'analyze', type: 'task', title: '分析', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'gw', type: 'gateway-xor', title: '复杂度' },
      { id: 'design', type: 'task', title: '设计', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'fix', type: 'task', title: '修复', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'analyze' },
      { from: 'analyze', to: 'gw' },
      // 旧配置：值是字符串 "true"（UI 输入框时代存入的），输出是布尔 true → 宽松匹配命中
      { from: 'gw', to: 'design', when: { field: 'passed', op: 'eq', value: 'true' } },
      { from: 'gw', to: 'fix', default: true },
      { from: 'design', to: 'end' }, { from: 'fix', to: 'end' },
    ],
  };
  const r = await runOrchestrator(wf, (label) => (label === '分析' ? { passed: true } : { ok: true }));
  assert.ok(r.agentCalls.includes('设计'), JSON.stringify(r.agentCalls));
  assert.ok(!r.agentCalls.includes('修复'), JSON.stringify(r.agentCalls));
});

// 构造 AND split/join 图
function andWorkflow() {
  return {
    id: 'wf-and', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'split', type: 'gateway-and', title: '分叉' },
      { id: 'b1', type: 'task', title: 'B1', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'b2', type: 'task', title: 'B2', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'join', type: 'gateway-and', title: '汇合' },
      { id: 'c', type: 'task', title: 'C', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'a' }, { from: 'a', to: 'split' },
      { from: 'split', to: 'b1' }, { from: 'split', to: 'b2' },
      { from: 'b1', to: 'join' }, { from: 'b2', to: 'join' },
      { from: 'join', to: 'c' }, { from: 'c', to: 'end' },
    ],
  };
}

test('orchestrator: AND split 并行执行分支，join 后继续', async () => {
  const { result, agentCalls } = await runOrchestrator(andWorkflow(), (label) => ({ label, ok: true }));
  assert.ok(agentCalls.includes('A'), JSON.stringify(agentCalls));
  assert.ok(agentCalls.includes('B1'), JSON.stringify(agentCalls));
  assert.ok(agentCalls.includes('B2'), JSON.stringify(agentCalls));
  assert.ok(agentCalls.includes('C'), JSON.stringify(agentCalls));
  const idx = (l) => agentCalls.indexOf(l);
  assert.ok(idx('C') > idx('B1') && idx('C') > idx('B2'), JSON.stringify(agentCalls));
  assert.equal(result.current, 'end');
});

test('orchestrator: AND split 某分支失败 → 整体失败（严格）', async () => {
  const { result, agentCalls } = await runOrchestrator(andWorkflow(), (label) => {
    if (label === 'B1') return null; // B1 失败
    return { ok: true };
  });
  assert.ok(!agentCalls.includes('C'), JSON.stringify(agentCalls)); // 严格失败，不执行 C
  assert.equal(result.ok, false);
});

// 构造循环图：review 不通过 → 回到 implement → 再 review。死循环由节点级 maxRuns（默认 3）保护
function loopWorkflow() {
  return {
    id: 'wf-loop', nodes: [
      { id: 'start', type: 'start' },
      { id: 'review', type: 'task', title: '评审', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'implement', type: 'task', title: '编码', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'review' },
      { from: 'review', to: 'implement', when: { field: 'passed', op: 'eq', value: false } },
      { from: 'review', to: 'end', default: true },
      { from: 'implement', to: 'review' },
    ],
  };
}

test('orchestrator: 环边触发回退后通过（默认 maxRuns=3 内）', async () => {
  let reviewCount = 0;
  const { result, agentCalls } = await runOrchestrator(loopWorkflow(), (label) => {
    if (label === '评审') {
      reviewCount++;
      return reviewCount === 1 ? { passed: false } : { passed: true };
    }
    return { ok: true };
  });
  assert.ok(agentCalls.includes('编码'), JSON.stringify(agentCalls)); // 回退执行了 implement
  assert.equal(reviewCount, 2); // 第一次 false 回退，第二次 true 通过
  assert.equal(result.current, 'end');
  assert.equal(result.ok, true);
});

test('orchestrator: 节点默认最多执行 3 次，超限失败（自动防死循环）', async () => {
  const { result, agentCalls } = await runOrchestrator(loopWorkflow(), (label) => {
    if (label === '评审') return { passed: false }; // 一直不通过
    return { ok: true };
  });
  assert.equal(result.ok, false);
  // review 第 1/2/3 次执行了 subagent，第 4 次尝试在派 agent 前被拦下
  assert.equal(agentCalls.filter((l) => l === '评审').length, 3);
});

test('orchestrator: maxRuns 可配置——=1 时重跑即失败且不浪费 subagent', async () => {
  const wf = loopWorkflow();
  wf.nodes.find((n) => n.id === 'review').maxRuns = 1;
  const { result, agentCalls } = await runOrchestrator(wf, (label) => {
    if (label === '评审') return { passed: false };
    return { ok: true };
  });
  assert.equal(result.ok, false);
  assert.equal(agentCalls.filter((l) => l === '评审').length, 1); // 第二次尝试直接失败，未派 agent
});

test('orchestrator: maxRuns 可配置——=2 时允许 1 次重跑', async () => {
  const wf = loopWorkflow();
  wf.nodes.find((n) => n.id === 'review').maxRuns = 2;
  let reviewCount = 0;
  const { result } = await runOrchestrator(wf, (label) => {
    if (label === '评审') {
      reviewCount++;
      return reviewCount === 1 ? { passed: false } : { passed: true };
    }
    return { ok: true };
  });
  assert.equal(result.ok, true);
  assert.equal(result.current, 'end');
});

// 构造人工节点图：review → approve(human) → approveTo:end / rejectTo:implement
function humanWorkflow() {
  return {
    id: 'wf-human', nodes: [
      { id: 'start', type: 'start' },
      { id: 'review', type: 'task', title: '评审', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'approve', type: 'human', title: '审批', displayFrom: 'review', approveTo: 'end', rejectTo: 'implement' },
      { id: 'implement', type: 'task', title: '编码', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'review' },
      { from: 'review', to: 'approve' },
      { from: 'implement', to: 'end' },
    ],
  };
}

test('orchestrator: human 节点暂停返回 paused', async () => {
  const { result, agentCalls } = await runOrchestrator(humanWorkflow(), (label) => ({ ok: true }));
  assert.equal(result.paused, true);
  assert.equal(result.pausedAt, 'approve');
  assert.ok(agentCalls.includes('评审'), JSON.stringify(agentCalls));
  assert.ok(!agentCalls.includes('编码'), JSON.stringify(agentCalls)); // 暂停，不继续
});

test('orchestrator: human 决策 approve 走 approveTo', async () => {
  const { result, agentCalls } = await runOrchestrator(humanWorkflow(), (label) => ({ ok: true }), {
    decision: { humanId: 'approve', value: 'approve' },
  });
  assert.equal(result.current, 'end');
  assert.ok(!agentCalls.includes('编码'), JSON.stringify(agentCalls)); // approveTo=end，跳过 implement
});

test('orchestrator: human 决策 reject 走 rejectTo', async () => {
  const { result, agentCalls } = await runOrchestrator(humanWorkflow(), (label) => ({ ok: true }), {
    decision: { humanId: 'approve', value: 'reject' },
  });
  assert.ok(agentCalls.includes('编码'), JSON.stringify(agentCalls)); // rejectTo=implement
  assert.equal(result.current, 'end');
});

test('orchestrator: human 未配置驳回去向 → 决策 reject 抛错而非静默完成', async () => {
  const wf = humanWorkflow();
  wf.nodes.find((n) => n.id === 'approve').rejectTo = ''; // 未配置驳回
  const { result } = await runOrchestrator(wf, (label) => ({ ok: true }), {
    decision: { humanId: 'approve', value: 'reject' },
  });
  assert.equal(result.ok, false); // 不能悄悄判成功
});

test('orchestrator: human 未配置通过去向 → 决策 approve 抛错而非静默完成', async () => {
  const wf = humanWorkflow();
  wf.nodes.find((n) => n.id === 'approve').approveTo = '';
  const { result } = await runOrchestrator(wf, (label) => ({ ok: true }), {
    decision: { humanId: 'approve', value: 'approve' },
  });
  assert.equal(result.ok, false);
});

// 多去向（routes）：通过 → end / 驳回 → implement / 小改 → fix
function multiRouteWorkflow() {
  return {
    id: 'wf-multi', nodes: [
      { id: 'start', type: 'start' },
      { id: 'review', type: 'task', title: '评审', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'approve', type: 'human', title: '设计评审', displayFrom: 'review', routes: [
        { label: '通过', to: 'end', tone: 'success' },
        { label: '驳回', to: 'implement', tone: 'danger' },
        { label: '小改', to: 'fix', tone: 'warning' },
      ] },
      { id: 'implement', type: 'task', title: '编码', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'fix', type: 'task', title: '小修', inputs: [], body: { prompt: '', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'review' },
      { from: 'review', to: 'approve' },
      { from: 'implement', to: 'end' },
      { from: 'fix', to: 'end' },
    ],
  };
}

test('orchestrator: human 多去向（routes）决策走对应目标', async () => {
  const { result, agentCalls } = await runOrchestrator(multiRouteWorkflow(), (label) => ({ ok: true }), {
    decision: { humanId: 'approve', value: '小改' },
  });
  assert.ok(agentCalls.includes('小修'), JSON.stringify(agentCalls)); // 小改 → fix
  assert.ok(!agentCalls.includes('编码'), JSON.stringify(agentCalls));
  assert.equal(result.current, 'end');
  assert.equal(result.ok, true);
});

test('orchestrator: human 决策不在去向列表 → 抛错', async () => {
  const { result } = await runOrchestrator(multiRouteWorkflow(), (label) => ({ ok: true }), {
    decision: { humanId: 'approve', value: '随便' },
  });
  assert.equal(result.ok, false);
});

test('orchestrator: human 多去向任意决策带意见 → 注入目标节点', async () => {
  const seen = [];
  const { result } = await runOrchestrator(multiRouteWorkflow(), (label, prompt) => {
    if (label === '小修') seen.push(prompt);
    return { ok: true };
  }, {
    decision: { humanId: 'approve', value: '小改', feedback: '文案要更简洁' },
  });
  assert.equal(result.ok, true);
  assert.ok(seen.length === 1 && seen[0].includes('[人工意见]') && seen[0].includes('文案要更简洁'), JSON.stringify(seen));
});

test('orchestrator: human 多去向兼容 approve/reject 旧决策值', async () => {
  const { result, agentCalls } = await runOrchestrator(multiRouteWorkflow(), (label) => ({ ok: true }), {
    decision: { humanId: 'approve', value: 'reject' }, // 旧值 → 驳回 → implement
  });
  assert.ok(agentCalls.includes('编码'), JSON.stringify(agentCalls));
  assert.equal(result.ok, true);
});

test('orchestrator: 断点恢复跳过已执行节点（initialResults + decision）', async () => {
  const initialResults = { review: { ok: true } };
  const { result, agentCalls } = await runOrchestrator(humanWorkflow(), (label) => ({ ok: true }), {
    decision: { humanId: 'approve', value: 'approve' },
    initialResults,
  });
  assert.ok(!agentCalls.includes('评审'), JSON.stringify(agentCalls)); // review 跳过，不重新执行
  assert.equal(result.current, 'end');
});

// 两个顺序人工节点：H1 决策后到 H2 暂停；对 H2 决策（带 decided 重放 H1）应直达 end，不弹回 H1
function twoHumanWorkflow() {
  return {
    id: 'wf-2h', nodes: [
      { id: 'start', type: 'start' },
      { id: 't1', type: 'task', title: 'T1', inputs: [], body: { prompt: 't1', mode: 'single', output: {} } },
      { id: 'h1', type: 'human', title: '一审', routes: [{ label: '通过', to: 't2', tone: 'success' }] },
      { id: 't2', type: 'task', title: 'T2', inputs: [], body: { prompt: 't2', mode: 'single', output: {} } },
      { id: 'h2', type: 'human', title: '二审', routes: [{ label: '通过', to: 'end', tone: 'success' }] },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 't1' }, { from: 't1', to: 'h1' }, { from: 'h1', to: 't2' },
      { from: 't2', to: 'h2' },
    ],
  };
}

test('orchestrator: 顺序两个人工节点——H2 决策时重放 H1 历史决策，不再弹回 H1 暂停', async () => {
  const wf = twoHumanWorkflow();
  // 第一轮：H1 决策通过 → T2 执行 → H2 暂停
  const r1 = await runOrchestrator(wf, () => ({ ok: true }), { decision: { humanId: 'h1', value: '通过' } });
  assert.equal(r1.result.paused, true);
  assert.equal(r1.result.pausedAt, 'h2');
  const initialResults = r1.result.results; // T1/T2 已完成
  // 第二轮：对 H2 决策 + decided 重放 H1（index.js buildDecidedMap 的行为）
  const r2 = await runOrchestrator(wf, () => ({ ok: true }), {
    decision: { humanId: 'h2', value: '通过' },
    decided: { h1: '通过' },
    initialResults,
  });
  assert.equal(r2.result.current, 'end', JSON.stringify(r2.result));
  assert.ok(!r2.result.paused);
  // T1/T2 被断点跳过，不重复执行
  assert.equal(r2.agentCalls.filter((l) => l === 'T1').length, 0, JSON.stringify(r2.agentCalls));
  assert.equal(r2.agentCalls.filter((l) => l === 'T2').length, 0, JSON.stringify(r2.agentCalls));
});

test('orchestrator: 无 decided 重放时，H2 决策重走图仍会在 H1 重新暂停（旧行为，用于对照）', async () => {
  const wf = twoHumanWorkflow();
  const r1 = await runOrchestrator(wf, () => ({ ok: true }), { decision: { humanId: 'h1', value: '通过' } });
  const r2 = await runOrchestrator(wf, () => ({ ok: true }), {
    decision: { humanId: 'h2', value: '通过' },
    initialResults: r1.result.results,
    // 不传 decided
  });
  assert.equal(r2.result.paused, true);
  assert.equal(r2.result.pausedAt, 'h1'); // 弹回 H1（这正是要靠 decided 修复的振荡）
});

test('orchestrator: task 节点零出边（断头）抛错而非静默成功', async () => {
  const wf = {
    id: 'wf-dead', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: 'a', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }], // a → end 缺失
  };
  const { result } = await runOrchestrator(wf, () => ({ ok: true }));
  assert.equal(result.ok, false);
  assert.match(result.error, /没有出边/);
});

// 构造 hook 图：task 有 prehook(exec) + posthook(builtin)
function hookWorkflow() {
  return {
    id: 'wf-hook', nodes: [
      { id: 'start', type: 'start' },
      {
        id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '主体', mode: 'single', output: {} },
        prehook: [
          { type: 'exec', prompt: '查工单拿分支', output: { type: 'object', properties: { branch: { type: 'string' } } }, as: 'branchInfo' },
        ],
        posthook: [
          { type: 'builtin', name: 'write-product', params: { path: 'docs/x.md' } },
        ],
      },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
  };
}

test('orchestrator: hook 执行 prehook(exec) + 主体 + posthook(builtin)，动作输出进 ctx', async () => {
  const { result, agentCalls } = await runOrchestrator(hookWorkflow(), (label) => {
    if (label === 'A:exec') return { branch: 'feature/x' };
    return { ok: true };
  });
  assert.ok(agentCalls.includes('A:exec'), JSON.stringify(agentCalls));
  assert.ok(agentCalls.includes('A'), JSON.stringify(agentCalls));
  assert.ok(agentCalls.includes('A:write-product'), JSON.stringify(agentCalls));
  assert.deepEqual(result.results['a.branchInfo'], { branch: 'feature/x' });
});

test('orchestrator: 主体 prompt 解析 ${ctx} 引用（上游输出 + 任务输入）', async () => {
  const wf = {
    id: 'wf-ref', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: 'A', mode: 'single', output: {} } },
      { id: 'b', type: 'task', title: 'B', inputs: [], body: { prompt: '处理工单 ${ctx.inputs.ticketNo}，分支 ${ctx.a.branch}', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'end' }],
  };
  let capturedPrompt = null;
  await runOrchestrator(wf, (label, prompt) => {
    if (label === 'A') return { branch: 'feature/x' };
    if (label === 'B') { capturedPrompt = prompt; return { ok: true }; }
    return { ok: true };
  }, { inputs: { ticketNo: 'JIRA-123' } });
  assert.ok(capturedPrompt.includes('JIRA-123'), capturedPrompt);
  assert.ok(capturedPrompt.includes('feature/x'), capturedPrompt);
  assert.ok(!capturedPrompt.includes('${ctx'), capturedPrompt); // 无残留占位符
});

test('orchestrator: 任务输入 inputs 进入 ctx，可在下游 prompt 引用', async () => {
  const wf = {
    id: 'wf-in', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '查工单 ${ctx.inputs.ticketNo}', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
  };
  let capturedPrompt = null;
  await runOrchestrator(wf, (label, prompt) => {
    if (label === 'A') { capturedPrompt = prompt; return { ok: true }; }
    return { ok: true };
  }, { inputs: { ticketNo: 'TICKET-42' } });
  assert.ok(capturedPrompt.includes('TICKET-42'), capturedPrompt);
});

test('orchestrator: 任务带 cwd 时自动声明工作目录，且 ${cwd} 可引用', async () => {
  const wf = {
    id: 'wf-cwd', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '写文件到 ${cwd}/notes.md', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
  };
  let capturedPrompt = null;
  await runOrchestrator(wf, (label, prompt) => {
    if (label === 'A') { capturedPrompt = prompt; return { ok: true }; }
    return { ok: true };
  }, { task: { id: 't1', title: 'T', taskDir: '.tasks/t1', cwd: 'C:/work/proj' } });
  // 自动声明：subagent 必须知道工作目录
  assert.ok(capturedPrompt.includes('[工作目录]'), capturedPrompt);
  assert.ok(capturedPrompt.includes('C:/work/proj'), capturedPrompt);
  // ${cwd} 引用解析为工作目录
  assert.ok(capturedPrompt.includes('写文件到 C:/work/proj/notes.md'), capturedPrompt);
  assert.ok(!capturedPrompt.includes('${cwd}'), capturedPrompt);
});

test('orchestrator: 任务无 cwd 时不注入工作目录声明', async () => {
  const wf = {
    id: 'wf-nocwd', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '只做分析', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
  };
  let capturedPrompt = null;
  await runOrchestrator(wf, (label, prompt) => {
    if (label === 'A') { capturedPrompt = prompt; return { ok: true }; }
    return { ok: true };
  });
  assert.ok(!capturedPrompt.includes('[工作目录]'), capturedPrompt);
});

test('orchestrator: 用户故事编码 storyCode 可引用（${storyCode}）', async () => {
  const wf = {
    id: 'wf-story', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '提交信息带用户故事：${storyCode}', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
  };
  let capturedPrompt = null;
  await runOrchestrator(wf, (label, prompt) => {
    if (label === 'A') { capturedPrompt = prompt; return { ok: true }; }
    return { ok: true };
  }, { task: { id: 't1', title: 'T', taskDir: '.tasks/t1', storyCode: 'US-123' } });
  assert.ok(capturedPrompt.includes('US-123'), capturedPrompt);
  assert.ok(!capturedPrompt.includes('${storyCode}'), capturedPrompt);
});

test('orchestrator: human reject 带 feedback → rejectTo 节点 prompt 含人工意见', async () => {
  let capturedPrompt = null;
  const { result, agentCalls } = await runOrchestrator(humanWorkflow(), (label, prompt) => {
    if (label === '编码') { capturedPrompt = prompt; return { ok: true }; }
    return { ok: true };
  }, {
    decision: { humanId: 'approve', value: 'reject', feedback: '缺少单元测试，请补充边界用例' },
  });
  assert.ok(agentCalls.includes('编码'), JSON.stringify(agentCalls));
  assert.ok(capturedPrompt.includes('缺少单元测试'), capturedPrompt);
  assert.ok(capturedPrompt.includes('人工意见'), capturedPrompt);
  assert.equal(result.current, 'end');
});

test('orchestrator: 节点级 parallel 派 N 个 subagent，结果合并成数组', async () => {
  const wf = {
    id: 'wf-par', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: '评审', inputs: [], body: { prompt: '评审代码', mode: 'parallel', parallelItems: 3, output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
  };
  const { result, agentCalls } = await runOrchestrator(wf, (label) => ({ label, ok: true }));
  assert.equal(agentCalls.filter((l) => l.startsWith('评审 #')).length, 3, JSON.stringify(agentCalls));
  assert.ok(Array.isArray(result.results.a), JSON.stringify(result.results));
  assert.equal(result.results.a.length, 3);
  assert.equal(result.current, 'end');
});

test('orchestrator: builtin 动作 params 支持 ${ctx} 动态引用', async () => {
  const wf = {
    id: 'wf-bp', nodes: [
      { id: 'start', type: 'start' },
      {
        id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '主体', mode: 'single', output: {} },
        posthook: [
          { type: 'builtin', name: 'write-product', params: { path: '${ctx.inputs.dir}/x.md' } },
        ],
      },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
  };
  let capturedPrompt = null;
  await runOrchestrator(wf, (label, prompt) => {
    if (label === 'A:write-product') { capturedPrompt = prompt; return { ok: true }; }
    return { ok: true };
  }, { inputs: { dir: 'docs' } });
  assert.ok(capturedPrompt.includes('docs/x.md'), capturedPrompt);
  assert.ok(!capturedPrompt.includes('${ctx'), capturedPrompt);
});

test('orchestrator: reject 时 rejectTo 目标即使已在 initialResults 也重新执行', async () => {
  let implementCount = 0;
  let capturedPrompt = null;
  const initialResults = { review: { ok: true }, implement: { ok: true } }; // implement 上一轮已执行过
  const { result } = await runOrchestrator(humanWorkflow(), (label, prompt) => {
    if (label === '编码') { implementCount++; capturedPrompt = prompt; return { ok: true }; }
    return { ok: true };
  }, {
    decision: { humanId: 'approve', value: 'reject', feedback: '再次驳回：补充边界用例' },
    initialResults,
  });
  assert.equal(implementCount, 1); // 修复节点应重新执行，不被 skipSet 跳过
  assert.ok(capturedPrompt.includes('再次驳回'), capturedPrompt);
  assert.equal(result.current, 'end');
});

test('orchestrator: 每节点成功后上报 checkpoint（[knj-checkpoint] 含 node 与 output）', async () => {
  const wf = {
    id: 'wf', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: 'A', mode: 'single', output: {} } },
      { id: 'b', type: 'task', title: 'B', inputs: [], body: { prompt: 'B', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'end' }],
  };
  const { result, logCalls } = await runOrchestrator(wf, (label) => ({ ok: true, value: label }));
  const cps = logCalls.filter((m) => typeof m === 'string' && m.startsWith('[knj-checkpoint]'))
    .map((m) => JSON.parse(m.slice('[knj-checkpoint]'.length)));
  assert.equal(cps.length, 2);
  assert.equal(cps[0].node, 'a');
  assert.deepEqual(cps[0].output, { ok: true, value: 'A' });
  assert.equal(cps[1].node, 'b');
  assert.equal(result.current, 'end');
});

test('orchestrator: 节点 subagent 无输出（返回 null）→ 整体失败（throw）', async () => {
  const wf = {
    id: 'wf', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: 'A', mode: 'single', output: {} } },
      { id: 'b', type: 'task', title: 'B', inputs: [], body: { prompt: 'B', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'end' }],
  };
  const { result, agentCalls } = await runOrchestrator(wf, (label) => (label === 'B' ? null : { ok: true }));
  assert.equal(result.ok, false); // 必须失败（throw），不能误判成功
  assert.ok(agentCalls.includes('A'));
  assert.ok(!(result.results && result.results.b)); // 失败节点结果不存在（throw 中断，results 可能缺失）
});

test('orchestrator: 不自动注入需求/上游输出，prompt 干净（工作目录会自动声明，显式 ${inputDescription} 生效）', async () => {
  const wf = {
    id: 'wf', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '按需求做：${inputDescription}', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
  };
  let capturedPrompt = null;
  const { result } = await runOrchestrator(wf, (label, prompt) => {
    if (label === 'A') capturedPrompt = prompt;
    return { ok: true };
  }, { task: { id: 't1', title: 'T', taskDir: '.tasks/t1', description: '做一个 url 解码工具，保存到 ~/story 下', cwd: '/tmp' } });
  // 需求/上游输出不自动注入；工作目录会声明（subagent 必须知道执行位置）；显式 ${inputDescription} 生效
  assert.ok(!capturedPrompt.includes('[任务需求]'), capturedPrompt);
  assert.ok(!capturedPrompt.includes('[上游节点输出]'), capturedPrompt);
  assert.ok(capturedPrompt.includes('[工作目录]'), capturedPrompt);
  assert.ok(capturedPrompt.includes('按需求做：做一个 url 解码工具，保存到 ~/story 下'), capturedPrompt);
  assert.equal(result.current, 'end');
});

test('orchestrator: 空 initialResults 时全部节点重新执行（重跑语义）', async () => {
  const wf = {
    id: 'wf', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: 'A', mode: 'single', output: {} } },
      { id: 'b', type: 'task', title: 'B', inputs: [], body: { prompt: 'B', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'end' }],
  };
  const { agentCalls, result } = await runOrchestrator(wf, (label) => ({ ok: true }), { initialResults: {} });
  assert.deepEqual(agentCalls, ['A', 'B']);
  assert.equal(result.current, 'end');
});

test('orchestrator: prompt 可引用 ${inputDescription}/${inputTitle}/${ctx.inputDescription}', async () => {
  const wf = {
    id: 'wf', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '需求：${inputDescription}，标题：${inputTitle}，完整：${ctx.inputDescription}', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
  };
  let capturedPrompt = null;
  const { result } = await runOrchestrator(wf, (label, prompt) => {
    if (label === 'A') capturedPrompt = prompt;
    return { ok: true };
  }, { task: { id: 't1', title: '测试标题', taskDir: '.tasks/t1', description: '做一个工具' } });
  assert.ok(capturedPrompt.includes('需求：做一个工具'), capturedPrompt);
  assert.ok(capturedPrompt.includes('标题：测试标题'), capturedPrompt);
  assert.ok(capturedPrompt.includes('完整：做一个工具'), capturedPrompt);
  assert.equal(result.current, 'end');
});

test('orchestrator: XOR 条件值可引用 ${ctx.inputs.x} 分流', async () => {
  const wf = {
    id: 'wf', nodes: [
      { id: 'start', type: 'start' },
      { id: 'c', type: 'task', title: 'C', inputs: [], body: { prompt: 'C', mode: 'single', output: {} } },
      { id: 'gw', type: 'gateway-xor', title: '分流', inputs: [] },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: 'A', mode: 'single', output: {} } },
      { id: 'b', type: 'task', title: 'B', inputs: [], body: { prompt: 'B', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'c' },
      { from: 'c', to: 'gw' },
      { from: 'gw', to: 'a', when: { field: 'level', op: 'eq', value: '${ctx.inputs.level}' } },
      { from: 'gw', to: 'b', default: true },
      { from: 'a', to: 'end' },
      { from: 'b', to: 'end' },
    ],
  };
  const { agentCalls } = await runOrchestrator(wf, (label) => ({ ok: true, level: label === 'C' ? 'high' : 'low' }), { inputs: { level: 'high' } });
  assert.ok(agentCalls.includes('A'), JSON.stringify(agentCalls)); // 条件值 ${ctx.inputs.level} 解析为 high，匹配 C 输出的 level，走 A
  assert.ok(!agentCalls.includes('B'), JSON.stringify(agentCalls));
});

test('orchestrator: 无前缀 ${节点id.字段} 引用（${ctx.前缀} 兼容）', async () => {
  const wf = {
    id: 'wf', nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: 'A', mode: 'single', output: {} } },
      { id: 'b', type: 'task', title: 'B', inputs: [], body: { prompt: 'x=${a.x}，旧写法=${ctx.a.x}', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'end' }],
  };
  let capturedPrompt = null;
  await runOrchestrator(wf, (label, prompt) => {
    if (label === 'A') return { x: 42 };
    if (label === 'B') { capturedPrompt = prompt; return { ok: true }; }
    return { ok: true };
  });
  assert.ok(capturedPrompt.includes('x=42'), capturedPrompt);        // 无前缀 ${a.x}
  assert.ok(capturedPrompt.includes('旧写法=42'), capturedPrompt);   // ${ctx.a.x} 兼容
});
