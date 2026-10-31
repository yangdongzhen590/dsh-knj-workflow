/**
 * dsh-knj-workflow AI 助手编排脚本测试（node:test，vm 沙箱）
 * 运行：node --test lib/assist-script.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('./assist-script.js', import.meta.url), 'utf8');

/** 在 vm 沙箱执行 assist 脚本，mock agent。agentImpl(label, prompt, opts) 返回 subagent 结果。 */
async function runAssistScript(args, agentImpl) {
  const agentCalls = [];
  const sandbox = {
    args,
    agent: async (prompt, opts) => {
      agentCalls.push({ prompt, opts });
      return agentImpl ? agentImpl(opts, prompt) : { reply: 'ok', edits: [] };
    },
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

test('assist-script: 读 args.prompt 派一个 subagent，透传 { reply, edits }', async () => {
  const fake = { reply: '好的，已加节点', edits: [{ action: 'add_node', type: 'task', id: 'x' }] };
  const { result, agentCalls } = await runAssistScript(
    { prompt: '系统提示：你是工作流助手。当前图摘要…\n用户：加节点' },
    () => fake,
  );
  assert.equal(agentCalls.length, 1);
  assert.match(agentCalls[0].prompt, /工作流助手/);
  assert.ok(agentCalls[0].opts?.schema, '应传输出 schema');
  assert.equal(result.reply, '好的，已加节点');
  assert.deepEqual(result.edits, [{ action: 'add_node', type: 'task', id: 'x' }]);
});

test('assist-script: agent 返回 null（schema 校验失败）→ 脚本显式失败', async () => {
  const { result } = await runAssistScript({ prompt: 'P' }, () => null);
  assert.equal(result.ok, false);
  assert.match(String(result.error || ''), /无有效输出|失败|null/i);
});

test('assist-script: agent 返回对象缺字段 → 容错缺省（reply 空串 / edits []）', async () => {
  const { result } = await runAssistScript({ prompt: 'P' }, () => ({ foo: 1 }));
  assert.equal(typeof result.reply, 'string');
  assert.ok(Array.isArray(result.edits));
});

test('assist-script: agent 返回 edits 非数组 → 容错为 []', async () => {
  const { result } = await runAssistScript({ prompt: 'P' }, () => ({ reply: 'R', edits: 'not-array' }));
  assert.equal(result.reply, 'R');
  assert.ok(Array.isArray(result.edits) && result.edits.length === 0);
});

test('assist-script: 输出 schema 限定 { reply: string, edits: array of object }', async () => {
  const { agentCalls } = await runAssistScript({ prompt: 'P' }, () => ({ reply: 'R', edits: [] }));
  const schema = agentCalls[0].opts.schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.reply.type, 'string');
  assert.ok(schema.required.includes('reply'));
  assert.equal(schema.properties.edits.type, 'array');
  assert.equal(schema.properties.edits.items.type, 'object');
});
