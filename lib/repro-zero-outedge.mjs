/**
 * Repro: task 节点零出边 — 校验通过但 orchestrator 静默判成功 vs graph.nextNode 抛错
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { validateWorkflow, nextNode } from './graph.js';

const code = readFileSync(new URL('./orchestrator.js', import.meta.url), 'utf8');

async function runOrchestrator(workflow, agentImpl, extraArgs = {}) {
  const agentCalls = [];
  const sandbox = {
    args: { config: workflow, task: { id: 't1', title: 'T', taskDir: '.tasks/t1' }, ...extraArgs },
    agent: async (prompt, opts) => { agentCalls.push(opts?.label ?? '?'); return agentImpl ? agentImpl(opts?.label, prompt) : { ok: true }; },
    parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
    phase: () => {},
    log: () => {},
    console,
  };
  const wrapped = `(async () => {\n${code}\n})()`;
  try {
    const result = await vm.runInNewContext(wrapped, sandbox, { timeout: 5000 });
    return { result, agentCalls };
  } catch (e) {
    return { result: { ok: false, error: e instanceof Error ? e.message : String(e) }, agentCalls };
  }
}

// ---- 场景 A：split 分支里的 task 节点 a 零出边（end 仍从另一分支可达）----
const wfA = {
  id: 'wf-a', nodes: [
    { id: 'start', type: 'start' },
    { id: 'g', type: 'gateway-and', title: '分叉' },
    { id: 'a', type: 'task', title: 'A（忘连出边）', inputs: [], body: { prompt: 'A', mode: 'single', output: {} } },
    { id: 'b', type: 'task', title: 'B', inputs: [], body: { prompt: 'B', mode: 'single', output: {} } },
    { id: 'end', type: 'end' },
  ],
  edges: [
    { from: 'start', to: 'g' },
    { from: 'g', to: 'a' },
    { from: 'g', to: 'b' },
    { from: 'b', to: 'end' },
  ],
};

// ---- 场景 B：XOR 分支里的 task 节点 a 零出边（default 边直达 end）----
const wfB = {
  id: 'wf-b', nodes: [
    { id: 'start', type: 'start' },
    { id: 'c', type: 'task', title: 'C', inputs: [], body: { prompt: 'C', mode: 'single', output: {} } },
    { id: 'x', type: 'gateway-xor', title: '分流' },
    { id: 'a', type: 'task', title: 'A（忘连出边）', inputs: [], body: { prompt: 'A', mode: 'single', output: {} } },
    { id: 'end', type: 'end' },
  ],
  edges: [
    { from: 'start', to: 'c' },
    { from: 'c', to: 'x' },
    { from: 'x', to: 'a', when: { field: 'level', op: 'eq', value: 'high' } },
    { from: 'x', to: 'end', default: true },
  ],
};

for (const [name, wf, agentImpl, extra] of [
  ['A-split-deadend', wfA, (label) => ({ label, ok: true }), {}],
  ['B-xor-deadend', wfB, (label) => (label === 'C' ? { level: 'high' } : { ok: true }), {}],
]) {
  const v = validateWorkflow(wf);
  const { result, agentCalls } = await runOrchestrator(wf, agentImpl, extra);
  let graphNextNodeThrows = null;
  try { nextNode(wf, 'a'); } catch (e) { graphNextNodeThrows = e.message; }
  console.log(`\n=== ${name} ===`);
  console.log('validateWorkflow:', JSON.stringify(v));
  console.log('orchestrator result:', JSON.stringify(result));
  console.log('agentCalls:', JSON.stringify(agentCalls));
  console.log('graph.nextNode("a") throws:', graphNextNodeThrows);
  console.log('=> 校验通过:', v.ok, '| 编排器 ok:', result.ok, '| current:', result.current, '| paused:', result.paused ?? 'undefined',
    '| 到达 end 吗:', result.current === 'end', '| finalizeTask 会标 success:', v.ok && result.ok && !result.paused && result.current !== 'end');
}

// ---- 场景 C：claim 的字面例子 start → a(task)，end 无入边（应被校验拦截）----
const wfC = {
  id: 'wf-c', nodes: [
    { id: 'start', type: 'start' },
    { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: 'A', mode: 'single', output: {} } },
    { id: 'end', type: 'end' },
  ],
  edges: [{ from: 'start', to: 'a' }],
};
console.log('\n=== C-claim-literal ===');
console.log('validateWorkflow(start→a, end 孤立):', JSON.stringify(validateWorkflow(wfC)));
