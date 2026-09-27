/**
 * 确定性复现：ts 流程「人工驳回 → fix → submit → 应再次暂停在 human」。
 * 复现 index.js decide 的完整调用形态：
 *   run1: 无决策 → 应 paused@human
 *   run2: decide 驳回（decision + initialResults = run1 暂停时的 results + decided = buildDecidedMap）
 * 期望：run2 fix 执行一次、submit 重新执行一次后，再次 paused@human（等第二轮审批）。
 * 现状：decidedMap 把「刚消费的驳回」当成可重放历史决策 → human 第二次到达时不再暂停，
 *       fix/submit 反复重执行直到节点 maxRuns(默认3) 超限抛错 → 人工节点永远无法重新触发。
 * 运行：node lib/repro-ts-review-loop.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('./orchestrator.js', import.meta.url), 'utf8');

const TS_WF = {
  id: 'ts', name: 'ts', inputs: [], schemaVersion: 2, revision: 2,
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'end', type: 'end' },
    { id: 'submit', type: 'task', title: 'submit', body: { prompt: 'submit', mode: 'single', output: {} } },
    { id: 'fix', type: 'task', title: 'fix', body: { prompt: 'fix', mode: 'single', output: {} } },
    { id: 'human-mttoi2zi', type: 'human', title: 'human', routes: [{ label: '通过', to: 'end', tone: 'success' }, { label: '驳回', to: 'fix', tone: 'danger' }] },
    { id: 'task-mttojmb8', type: 'task', title: 'dev', body: { prompt: 'dev', mode: 'single', output: {} } },
  ],
  edges: [
    { from: 'submit', to: 'human-mttoi2zi' },
    { from: 'fix', to: 'submit' },
    { from: 'start', to: 'task-mttojmb8' },
    { from: 'task-mttojmb8', to: 'submit' },
  ],
};

async function runOrchestrator(agentImpl, extraArgs = {}) {
  const agentCalls = [];
  const sandbox = {
    args: { config: TS_WF, task: { id: 't1', title: 'T', taskDir: '.tasks/t1' }, ...extraArgs },
    agent: async (prompt, opts) => {
      agentCalls.push(opts?.label ?? '?');
      return agentImpl ? agentImpl(opts?.label, prompt) : { ok: true };
    },
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

const counts = { fix: 0, submit: 0, dev: 0 };
const agentImpl = (label) => {
  if (label === 'fix') counts.fix++;
  if (label === 'submit') counts.submit++;
  if (label === 'dev') counts.dev++;
  return { label, ok: true };
};

// run1：首轮执行 → 暂停在 human
const r1 = await runOrchestrator(agentImpl, {});
console.log('== run1（首次执行）==');
console.log('  paused:', r1.result.paused, ' pausedAt:', r1.result.pausedAt, ' ok:', r1.result.ok);
console.log('  agentCalls:', JSON.stringify(r1.agentCalls));
console.log('  counts:', JSON.stringify(counts));
if (!r1.result.paused || r1.result.pausedAt !== 'human-mttoi2zi') {
  console.log('\n[前置失败] run1 未暂停在 human，场景前提不成立');
  process.exit(1);
}

// run2：Host decide 形态 —— 驳回
const initialResults = r1.result.results;
const decided = { 'human-mttoi2zi': '驳回' };
counts.fix = counts.submit = counts.dev = 0;
const r2 = await runOrchestrator(agentImpl, {
  decision: { humanId: 'human-mttoi2zi', value: '驳回', feedback: '需要修改' },
  initialResults,
  decided,
});
console.log('\n== run2（驳回决策，期望 fix 跑一次 + submit 重跑一次后再次 paused@human）==');
console.log('  paused:', r2.result.paused, ' pausedAt:', r2.result.pausedAt, ' ok:', r2.result.ok);
console.log('  error:', r2.result.error || '(无)');
console.log('  agentCalls:', JSON.stringify(r2.agentCalls));
console.log('  counts:', JSON.stringify(counts));

const fixed = r2.result.paused === true && r2.result.pausedAt === 'human-mttoi2zi' && counts.fix === 1 && counts.submit === 1;
console.log('\n结论:', fixed
  ? '符合预期：驳回后 fix+submit 一轮 → 重新暂停等人工（可再通过/驳回）'
  : 'BUG 复现：human 未被重新触发（' + (r2.result.paused ? `停在了 ${r2.result.pausedAt}` : '没有再暂停') + '），'
    + '实际 fix 执行 ' + counts.fix + ' 次 / submit 执行 ' + counts.submit + ' 次'
    + (r2.result.error ? '，最终报错: ' + r2.result.error : ''));
process.exit(fixed ? 0 : 2);
