/**
 * dsh-knj-workflow AI 助手对话通道测试（node:test）
 * ---------------------------------------------------------------
 * 覆盖：
 *  - WorkflowBridge.runAssist：parent/engine 解析、prompt 组装透传、结果透传、引擎不可用报错
 *  - POST /devtask/assist 路由：参数校验(400)、edits 经 applyEdits 应用、
 *    非法 edits 被 rejected 且 workflow 不被污染(200)、bridge 抛错 → 500
 *
 * 运行：node --test lib/assist-route.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WorkflowBridge, registerRoutes } from './index.js';

/** 样例图：start → a(task) → end（合法） */
function wf() {
  return {
    id: 'wf-assist', name: '助手测试', schemaVersion: 2, revision: 1, inputs: [],
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'a', type: 'task', title: 'A', inputs: [], body: { prompt: '做 A', mode: 'single', output: {} } },
      { id: 'end', type: 'end' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
  };
}

/** mock 环境：agents + scope 内 workflowEngine；engineStart 返回脚本产出 value。 */
function makeEnv({ value = { reply: '好的', edits: [] }, engineAvailable = true, resolveDelayMs = 0 } = {}) {
  const recorded = { engineStartOpts: null, handlers: {} };
  const engine = {
    start(opts) {
      recorded.engineStartOpts = opts;
      return {
        id: 'run-assist-1',
        cancel() {},
        dispose() {},
        // resolveDelayMs 模拟"run 持续一段时间"（真实一轮对话数十秒）——
        // 采集器需要这段时间来轮询/回退，立即 resolve 会让 done 先到、采集被取消
        result: new Promise((res) => setTimeout(
          () => res({ stopReason: 'completed', value }),
          resolveDelayMs,
        )),
      };
    },
  };
  const parentAgent = {
    id: 'parent-assist',
    scope: { ctx: { get: (n) => (n === 'workflowEngine' && engineAvailable ? engine : undefined) } },
  };
  // 真实宿主里 currentInitiator() 返回的是 Agent 实例（有 id 与 scope）；
  // assist 直接以它作为 parent（不新建专用会话）。
  const seed = { id: 'parent-assist', session: { header: { cwd: 'D:/w' } }, options: {}, scope: parentAgent.scope };
  const agents = {
    currentInitiator: () => seed,
    roots: () => [seed],
    async create() { return { agent: parentAgent, dispose: async () => {} }; },
  };
  const ctx = {
    on(name, fn) { recorded.handlers[name] = fn; },
    off(name) { recorded.offs = recorded.offs || {}; recorded.offs[name] = (recorded.offs[name] || 0) + 1; },
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'agents') return agents;
      if (name === 'agentPresets') return { async resolve() { return { id: 'standard' }; }, async mount() {} };
      return undefined;
    },
  };
  const store = { tasksDir: '.tasks', root: '.', getWorkflow: async () => null };
  return { ctx, store, recorded };
}

function fakeRes() {
  return {
    headersSent: false, statusCode: 0, body: null,
    writeHead(s) { this.statusCode = s; this.headersSent = true; },
    end(d) { this.body = d ? JSON.parse(d) : null; },
  };
}
function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method; req.url = url;
  if (body !== undefined) process.nextTick(() => { req.emit('data', JSON.stringify(body)); req.emit('end'); });
  else process.nextTick(() => req.emit('end'));
  return req;
}
function mount(store, bridge) {
  const registrations = [];
  registerRoutes({ effect(fn) { fn(); return () => {}; }, webServer: { register: (r) => registrations.push(r) } }, store, bridge, '');
  return registrations[0].handler;
}

// ---------------------------------------------------------------------------
// WorkflowBridge.runAssist
// ---------------------------------------------------------------------------
test('runAssist: 解析 parent scope 的 engine 并用 assist 脚本启动，透传 { reply, edits }', async () => {
  const { ctx, store, recorded } = makeEnv({
    value: { reply: '已加验证节点', edits: [{ action: 'add_node', type: 'task', id: 'task-verify', title: 'Verify' }] },
  });
  const bridge = new WorkflowBridge(ctx, store, '');
  const out = await bridge.runAssist({ workflow: wf(), message: '加一个验证节点', history: [] });

  assert.ok(recorded.engineStartOpts, 'engine.start 应被调用');
  assert.equal(recorded.engineStartOpts.parent?.id, 'parent-assist', '应以解析到的 agent 作为 parent');
  assert.match(String(recorded.engineStartOpts.script || ''), /工作流设计助手|assist/i,
    'engine 应收到 assist 脚本内容（而非编排器脚本）');
  assert.equal(out.reply, '已加验证节点');
  assert.equal(out.edits.length, 1);
});

test('runAssist: args.prompt 含图摘要与用户消息（Host 侧组装）', async () => {
  const { ctx, store, recorded } = makeEnv();
  const bridge = new WorkflowBridge(ctx, store, '');
  await bridge.runAssist({ workflow: wf(), message: '把 A 拆成两步', history: [] });

  const prompt = String(recorded.engineStartOpts.args?.prompt || '');
  assert.match(prompt, /把 A 拆成两步/, 'prompt 必须包含用户本轮指令');
  assert.match(prompt, /\[a\]|wf-assist|助手测试/, 'prompt 必须包含当前图摘要（节点 id 或工作流名）');
  assert.match(prompt, /add_node|add_edge/, 'prompt 必须包含编辑动作规则卡');
});

test('runAssist: 历史对话并入 prompt（多轮上下文）', async () => {
  const { ctx, store, recorded } = makeEnv();
  const bridge = new WorkflowBridge(ctx, store, '');
  await bridge.runAssist({
    workflow: wf(),
    message: '再加班',
    history: [{ role: 'user', content: '先加设计' }, { role: 'assistant', content: '已加设计节点' }],
  });
  const prompt = String(recorded.engineStartOpts.args?.prompt || '');
  assert.match(prompt, /先加设计/);
  assert.match(prompt, /已加设计节点/);
});

test('runAssist: 引擎不可用 → 明确报错（不静默成功）', async () => {
  const { ctx, store } = makeEnv({ engineAvailable: false });
  const bridge = new WorkflowBridge(ctx, store, '');
  await assert.rejects(
    () => bridge.runAssist({ workflow: wf(), message: 'x' }),
    /workflowEngine|不可用|unavailable/i,
  );
});

test('runAssist: 缺 workflow/message 时拒绝', async () => {
  const { ctx, store } = makeEnv();
  const bridge = new WorkflowBridge(ctx, store, '');
  await assert.rejects(() => bridge.runAssist({ message: 'x' }), /workflow/);
  await assert.rejects(() => bridge.runAssist({ workflow: wf() }), /message|指令/);
});

// ---------------------------------------------------------------------------
// Phase 5：过程信息量（sessionQuery 事件流 → stream 快照）
// ---------------------------------------------------------------------------
/**
 * mock sessionQuery：readSession 为主数据源（含事件体），可配置 readSurface 回退。
 * batches 语义：第 n 次调用返回第 n 批（模拟实时增量）。
 */
function makeSessionQuery({ batches = [], surface = null, readSessionThrows = false } = {}) {
  const calls = { count: 0, lastSessionId: null };
  const pickBatch = () => {
    const i = calls.count++;
    return batches[Math.min(i, Math.max(0, batches.length - 1))] || [];
  };
  const service = {
    async readSession(sessionId) {
      calls.lastSessionId = sessionId;
      if (readSessionThrows) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND');
      return { session: {}, inheritedEventCount: 0, events: pickBatch() };
    },
  };
  if (surface) {
    service.readSurface = async (sessionId) => {
      calls.lastSessionId = sessionId;
      calls.surfaceCalls = (calls.surfaceCalls || 0) + 1;
      return { session: {}, capturedThroughSeq: 9, events: surface };
    };
  }
  return { calls, service };
}

/** 带 sessionQuery 的 mock 环境 */
function makeEnvWithQuery(sessionQueryFactory, opts = {}) {
  const env = makeEnv(opts);
  const origGet = env.ctx.get.bind(env.ctx);
  env.ctx.get = (name) => (name === 'sessionQuery' ? sessionQueryFactory : origGet(name));
  return env;
}

/** 原始事件（扁平形状：chunk 直接在事件体上，readSession 的 SessionEvent 形状） */
const CHUNK = (seq, chunk) => ({ seq, type: 'assistant/chunk', time: 1, chunk });

test('采集器（readSession 主路径）：text-delta / reasoning-delta / tool-call-delta 映射进 stream', async () => {
  const sq = makeSessionQuery({
    batches: [[
      CHUNK(1, { type: 'block-start', index: 0, blockType: 'text' }),
      CHUNK(2, { type: 'reasoning-delta', index: 0, text: '先看这张图…' }),
      CHUNK(3, { type: 'text-delta', index: 0, text: '我准备在 end 前' }),
      { seq: 4, type: 'assistant/chunk', time: 1, turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 1, id: 't1', name: 'read_file', argumentsDelta: '{"path":"a.js"}' } },
    ]],
  });
  const { ctx, store, recorded } = makeEnvWithQuery(sq.service, { value: { reply: 'done', edits: [] } });
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  recorded.handlers['workflow/agent-start']?.({ id: 'run-assist-1' }, { label: '工作流设计助手', childId: 'child-9' });

  await new Promise((r) => setTimeout(r, 60));
  const p = bridge.assistProgress(requestId, 0);
  assert.ok(p.stream, 'progress 应带 stream 快照');
  assert.match(p.stream.text, /我准备在 end 前/, '正文增量应进 stream.text');
  assert.match(p.stream.reasoning, /先看这张图/, '推理增量应进 stream.reasoning');
  assert.ok(p.stream.tools.length >= 1, '工具调用应进 stream.tools');
  assert.equal(p.stream.tools[0].name, 'read_file');
  assert.match(String(p.stream.tools[0].args), /a\.js/);
  assert.equal(sq.calls.lastSessionId, 'child-9', '应按助手会话 id 读取');
  assert.equal(p.stream.diag.source, 'readSession', 'diag 应记录数据源为 readSession');
  assert.ok(p.stream.diag.types['assistant/chunk'] >= 3, 'diag 应记录事件类型计数');
});

test('采集器：嵌套 payload 形状（ev.payload.chunk）同样能提取', async () => {
  const sq = makeSessionQuery({
    batches: [[
      { seq: 1, type: 'assistant/chunk', payload: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '嵌套形状也能读' } } },
      { seq: 2, type: 'tool/call', payload: { id: 'c1', name: 'grep', arguments: { pattern: 'x' } } },
      { seq: 3, type: 'tool/result', payload: { id: 'c1', ok: true, content: '命中 3 处' } },
    ]],
  });
  const { ctx, store, recorded } = makeEnvWithQuery(sq.service, { value: { reply: 'done', edits: [] } });
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  recorded.handlers['workflow/agent-start']?.({ id: 'run-assist-1' }, { label: '助手', childId: 'child-9' });

  await new Promise((r) => setTimeout(r, 60));
  const p = bridge.assistProgress(requestId, 0);
  assert.match(p.stream.text, /嵌套形状也能读/);
  const tool = p.stream.tools.find((t) => t.name === 'grep');
  assert.ok(tool, 'tool/call 应生成卡片');
  assert.match(String(tool.result), /命中 3 处/, 'tool/result 应回填结果');
});

test('采集器（真实日志形状）：data 包裹 + reasoning-chunks / tool-call-chunks 批量压缩事件', async () => {
  // 形状来自真实助手会话日志（tools/diag-session-log.mjs 实测）
  const sq = makeSessionQuery({
    batches: [[
      { type: 'assistant/chunk', seq: 15, time: 1, data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } } },
      { type: 'reasoning-chunks', seq0: 16, time0: 2, data: { turn: 1, step: 1, index: 0, dt: [2, 1], texts: ['先看', '这张图'] } },
      { type: 'tool-call-chunks', seq0: 17, time0: 3, data: { turn: 1, step: 1, index: 1, dt: [1, 1], id: 'call_1', name: 'structured_output', args: ['{"reply"', ': "done"}'] } },
      { type: 'tool/call', seq: 18, time: 4, data: { turn: 1, step: 1, callId: 'call_1', name: 'structured_output', arguments: '{"reply": "done"}' } },
      { type: 'tool/result', seq: 19, time: 5, data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'Structured output recorded.' }], isError: false }] } } },
      { type: 'assistant/message', seq: 20, time: 6, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '（思考）' }, { type: 'text', text: '已在 end 前插入汇总节点。' }], usage: { inputTokens: 1200, outputTokens: 340 } } } },
    ]],
  });
  const { ctx, store, recorded } = makeEnvWithQuery(sq.service, { value: { reply: 'done', edits: [] } });
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  recorded.handlers['workflow/agent-start']?.({ id: 'run-assist-1' }, { label: '助手', childId: 'child-9' });

  await new Promise((r) => setTimeout(r, 60));
  const p = bridge.assistProgress(requestId, 0);
  assert.match(p.stream.reasoning, /先看这张图/, 'reasoning-chunks 的 texts 应拼接进推理');
  assert.match(p.stream.text, /已在 end 前插入汇总节点/, 'assistant/message 的 text 块应进正文');
  const tool = p.stream.tools.find((t) => t.name === 'structured_output');
  assert.ok(tool, 'tool-call-chunks 应生成工具卡片（含工具名）');
  assert.match(String(tool.args), /reply/, 'tool-call-chunks 的 args 分片应拼接');
  assert.match(String(tool.result), /Structured output recorded/, 'tool/result 嵌套内容应提取');
  assert.equal(tool.status, 'done');
  assert.deepEqual(p.stream.usage, { inputTokens: 1200, outputTokens: 340 }, 'usage 应取自 assistant/message');
});

test('采集器：压缩事件的 seq0 游标去重（readSession 返回全量日志不重复累积）', async () => {
  const batch = [
    { type: 'reasoning-chunks', seq0: 100, time0: 1, data: { texts: ['AAA'] } },
    { type: 'tool-call-chunks', seq0: 101, time0: 2, data: { id: 'c', name: 't', args: ['bb'] } },
  ];
  const sq = makeSessionQuery({ batches: [batch, batch, batch] }); // 每次返回全量
  const { ctx, store, recorded } = makeEnvWithQuery(sq.service, { value: { reply: 'ok', edits: [] }, resolveDelayMs: 600 });
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  recorded.handlers['workflow/agent-start']?.({ id: 'run-assist-1' }, { label: '助手', childId: 'child-9' });

  await new Promise((r) => setTimeout(r, 200));
  const p = bridge.assistProgress(requestId, 0);
  assert.equal(p.stream.reasoning, 'AAA', `seq0 去重失败会重复累积（实际 ${JSON.stringify(p.stream.reasoning)}）`);
  assert.equal(p.stream.tools.length, 1, '工具卡片不应重复');
  assert.equal(p.stream.tools[0].args, 'bb');
});

test('采集器：结构化输出（schema 模式）——从 tool args 增量提取 reply 作为正文流', async () => {
  // 真实情况（实测）：assist-script 用 schema 输出，模型不产生 text 块，
  // 而是逐块生成 structured_output 的 {"reply": "...", "edits": [...]}
  const sq = makeSessionQuery({
    batches: [[
      { type: 'assistant/chunk', seq: 1, time: 1, data: { chunk: { type: 'tool-call-delta', index: 0, id: 'c1', name: 'structured_output', argumentsDelta: '{"reply": "已在 ' } } },
      { type: 'assistant/chunk', seq: 2, time: 2, data: { chunk: { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: 'end 前插入' } } },
      { type: 'assistant/chunk', seq: 3, time: 3, data: { chunk: { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '汇总节点。\\n\\n然后接' } } },
      { type: 'assistant/chunk', seq: 4, time: 4, data: { chunk: { type: 'tool-call-delta', index: 0, id: 'c1', argumentsDelta: '到 end。", "edits": []}' } } },
    ]],
  });
  const { ctx, store, recorded } = makeEnvWithQuery(sq.service, { value: { reply: 'done', edits: [] } });
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  recorded.handlers['workflow/agent-start']?.({ id: 'run-assist-1' }, { label: '助手', childId: 'child-9' });

  await new Promise((r) => setTimeout(r, 60));
  const p = bridge.assistProgress(requestId, 0);
  assert.match(p.stream.text, /已在 end 前插入汇总节点/, `正文流应从 args 提取（实际 ${JSON.stringify(p.stream.text)}）`);
  assert.match(p.stream.text, /然后接到 end/, '后续增量应继续追加');
  assert.ok(!p.stream.text.includes('"reply"'), '不应把 JSON 外壳混进正文');
  assert.ok(!/edits/.test(p.stream.text), '不应把 edits 段落混进正文');
});

test('采集器（实时通道）：session/event 逐条到达即累积，diag.live 计数', async () => {
  // 实时为主：宿主在会话作用域逐条派发 session/event（无需等日志 flush）
  const sq = makeSessionQuery({ batches: [[]] }); // 轮询返回空，验证内容全部来自实时通道
  const { ctx, store, recorded } = makeEnvWithQuery(sq.service, { value: { reply: 'ok', edits: [] }, resolveDelayMs: 500 });
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  recorded.handlers['workflow/agent-start']?.({ id: 'run-assist-1' }, { label: '助手', childId: 'child-9' });

  await new Promise((r) => setTimeout(r, 20));
  const onSessionEvent = recorded.handlers['session/event'];
  assert.equal(typeof onSessionEvent, 'function', '应订阅 session/event 实时事件');

  // 模拟宿主逐条派发（签名：(session, event)）
  onSessionEvent({ id: 'child-9' }, { type: 'assistant/chunk', seq: 1, time: 1, data: { chunk: { type: 'reasoning-delta', index: 0, text: '实时推理' } } });
  onSessionEvent({ id: 'other-session' }, { type: 'assistant/chunk', seq: 2, time: 2, data: { chunk: { type: 'reasoning-delta', index: 0, text: '别人的会话' } } });
  onSessionEvent({ id: 'child-9' }, { type: 'reasoning-chunks', seq0: 3, time0: 3, data: { texts: ['，分批也认'] } });

  await new Promise((r) => setTimeout(r, 30));
  const p = bridge.assistProgress(requestId, 0);
  assert.match(p.stream.reasoning, /实时推理/, '实时事件应即时进入 stream');
  assert.match(p.stream.reasoning, /分批也认/, '压缩型实时事件也应处理');
  assert.ok(!p.stream.reasoning.includes('别人的会话'), '应过滤非本会话事件');
  assert.ok(p.stream.diag.live >= 2, `diag.live 应记录实时事件数（实际 ${p.stream.diag.live}）`);
});

test('采集器（实时 + 轮询去重）：同一 seq 不被累积两次', async () => {
  const ev = { type: 'assistant/chunk', seq: 7, time: 7, data: { chunk: { type: 'text-delta', index: 0, text: 'XYZ' } } };
  const sq = makeSessionQuery({ batches: [[ev]] }); // 轮询会再返回同一事件
  const { ctx, store, recorded } = makeEnvWithQuery(sq.service, { value: { reply: 'ok', edits: [] }, resolveDelayMs: 3000 });
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  recorded.handlers['workflow/agent-start']?.({ id: 'run-assist-1' }, { label: '助手', childId: 'child-9' });

  await new Promise((r) => setTimeout(r, 20));
  recorded.handlers['session/event']?.({ id: 'child-9' }, ev); // 实时先到
  await new Promise((r) => setTimeout(r, 2300)); // 等轮询兜底跑一轮（2s 间隔）
  const p = bridge.assistProgress(requestId, 0);
  assert.equal(p.stream.text, 'XYZ', `实时与轮询不应重复累积（实际 ${JSON.stringify(p.stream.text)}）`);
});

test('采集器：done 后注销 session/event 监听（不留常驻监听器）', async () => {
  const sq = makeSessionQuery({ batches: [[]] });
  const { ctx, store, recorded } = makeEnvWithQuery(sq.service, { value: { reply: 'ok', edits: [] } });
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  recorded.handlers['workflow/agent-start']?.({ id: 'run-assist-1' }, { label: '助手', childId: 'child-9' });
  await new Promise((r) => setTimeout(r, 80));
  const p = bridge.assistProgress(requestId, 0);
  assert.equal(p.done, true);
  assert.equal(recorded.offs?.['session/event'], 1, '完成后应注销 session/event 监听');
});

test('采集器：readSession 抛错 → 回退 readSurface 仍能取到助手文本', async () => {
  const sq = makeSessionQuery({
    readSessionThrows: true,
    surface: [
      { type: 'assistant/message', message: { content: [{ type: 'text', text: '回退路径的助手文本' }], usage: { inputTokens: 10, outputTokens: 5 } } },
    ],
  });
  // run 持续 400ms：给"回退到次一级数据源"留出采集窗口（真实一轮对话数十秒）
  const { ctx, store, recorded } = makeEnvWithQuery(sq.service, { value: { reply: 'ok', edits: [] }, resolveDelayMs: 400 });
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  recorded.handlers['workflow/agent-start']?.({ id: 'run-assist-1' }, { label: '助手', childId: 'child-9' });

  await new Promise((r) => setTimeout(r, 150));
  const p = bridge.assistProgress(requestId, 0);
  assert.ok(p.stream, '应仍产出 stream');
  assert.equal(p.stream.diag.source, 'readSurface', 'diag 应显示回退到 readSurface');
  assert.match(p.stream.text, /回退路径的助手文本/, '回退路径也要能取到文本');
});

test('采集器：seq 增量——重复轮询不重复累积文本', async () => {
  const batch = [CHUNK(1, { type: 'text-delta', index: 0, text: 'AAA' })];
  const sq = makeSessionQuery({ batches: [batch, batch, batch] }); // 每次都返回同一批（真实场景是累积返回全量日志）
  const { ctx, store, recorded } = makeEnvWithQuery(sq.service, { value: { reply: 'done', edits: [] } });
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  recorded.handlers['workflow/agent-start']?.({ id: 'run-assist-1' }, { label: '助手', childId: 'child-9' });

  await new Promise((r) => setTimeout(r, 120));
  const p = bridge.assistProgress(requestId, 0);
  assert.equal(p.stream.text, 'AAA', `同一 seq 不应重复累积（实际 ${JSON.stringify(p.stream.text)}）`);
});

test('采集器：sessionQuery 不可用 → 静默降级，对话主流程不受影响', async () => {
  const { ctx, store, recorded } = makeEnv({ value: { reply: '已加验证', edits: [] } }); // ctx.get 无 sessionQuery
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  recorded.handlers['workflow/agent-start']?.({ id: 'run-assist-1' }, { label: '助手', childId: 'child-9' });

  await new Promise((r) => setTimeout(r, 60));
  const p = bridge.assistProgress(requestId, 0);
  assert.equal(p.done, true, '无 sessionQuery 也应正常完成');
  assert.equal(p.result.reply, '已加验证');
  assert.ok(!p.stream || (p.stream.text === '' && p.stream.tools.length === 0), '降级时 stream 为空');
});

test('采集器：所有读取方法都失败 → 不崩溃、正常完成', async () => {
  const sq = makeSessionQuery({ readSessionThrows: true }); // 无 readSurface 可回退
  const { ctx, store, recorded } = makeEnvWithQuery(sq.service, { value: { reply: 'ok', edits: [] } });
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  recorded.handlers['workflow/agent-start']?.({ id: 'run-assist-1' }, { label: '助手', childId: 'child-9' });

  await new Promise((r) => setTimeout(r, 80));
  const p = bridge.assistProgress(requestId, 0);
  assert.equal(p.done, true, '读取失败不得影响主流程');
  assert.equal(p.result.reply, 'ok');
});


// ---------------------------------------------------------------------------
// startAssist（异步）+ assistProgress（过程事件）
// ---------------------------------------------------------------------------
test('startAssist: 立即返回 requestId，并把助手生命周期事件积累进 progress', async () => {
  const { ctx, store, recorded } = makeEnv({ value: { reply: '已加验证', edits: [] } });
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: '加验证节点', history: [] });
  assert.ok(requestId, '应立即返回 requestId');

  // 引擎把事件派发给 Host 注册的监听器（真实宿主同款签名 (info, payload)）
  recorded.handlers['workflow/agent-start']?.({ id: 'run-assist-1' }, { label: '工作流设计助手', childId: 'child-9' });
  recorded.handlers['workflow/log']?.({ id: 'run-assist-1' }, '已读取当前流程图，开始设计改动…');
  recorded.handlers['workflow/agent-end']?.({ id: 'run-assist-1' }, { label: '工作流设计助手' });

  const mid = bridge.assistProgress(requestId, 0);
  assert.equal(mid.done, false, '尚未完成');
  const texts = mid.events.map((e) => e.text).join(' | ');
  assert.match(texts, /设计助手|助手/, '过程应含助手启动事件');
  assert.match(texts, /已读取当前流程图/, '过程应含脚本 log 台词');

  // 等结果落地
  await new Promise((r) => setTimeout(r, 20));
  const done = bridge.assistProgress(requestId, 0);
  assert.equal(done.done, true);
  assert.equal(done.result.reply, '已加验证');
  assert.ok(Array.isArray(done.result.applied), 'result 应含 applied');
  assert.ok(done.result.elapsedMs >= 0, 'result 应带耗时');
});

test('assistProgress: since 参数只取增量事件；未知 id 返回 null', async () => {
  const { ctx, store } = makeEnv();
  const bridge = new WorkflowBridge(ctx, store, '');
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  await new Promise((r) => setTimeout(r, 20));
  const all = bridge.assistProgress(requestId, 0);
  const tail = bridge.assistProgress(requestId, all.events.length);
  assert.equal(tail.events.length, 0, 'since=末尾时无新增');
  assert.equal(bridge.assistProgress('nope', 0), null);
});

test('startAssist: 执行失败（助手无有效输出） → progress 返回 done + error', async () => {
  const { ctx, store } = makeEnv();
  // 让脚本产出为空对象（无 reply/edits 会走容错；这里直接让 run.result 无 value）
  const bridge = new WorkflowBridge(ctx, store, '');
  const orig = bridge.runAssist.bind(bridge);
  bridge.runAssist = async () => { throw new Error('设计助手无有效产出（run 未返回 { reply, edits }）'); };
  const { requestId } = bridge.startAssist({ workflow: wf(), message: 'x' });
  await new Promise((r) => setTimeout(r, 20));
  const p = bridge.assistProgress(requestId, 0);
  assert.equal(p.done, true);
  assert.match(String(p.error || ''), /无有效产出/);
  bridge.runAssist = orig;
});

// ---------------------------------------------------------------------------
// POST /assist（异步启动）+ GET /assist/progress（过程事件）
// ---------------------------------------------------------------------------
const stubStore = { tasksDir: '.tasks', root: '.', listWorkflows: async () => [], getWorkflow: async () => null };
const noopBridge = { isRunning: () => false, startTask: async () => ({}), cancelTask() {} };

test('POST /assist: 异步启动 → 202 + requestId（不等整轮完成）', async () => {
  const bridge = { ...noopBridge, startAssist: () => ({ requestId: 'as-1' }) };
  const handler = mount(stubStore, bridge);
  const res = fakeRes();
  await handler(fakeReq('POST', '/assist', { workflow: wf(), message: '加验证节点' }), res);
  assert.equal(res.statusCode, 202, '异步启动应回 202 而不是等完成');
  assert.equal(res.body.requestId, 'as-1');
});

test('GET /assist/progress: 按 since 增量返回过程事件，未完成时 done=false', async () => {
  const all = [
    { seq: 1, kind: 'start', text: '已启动设计助手', ts: 't1' },
    { seq: 2, kind: 'log', text: '已读取当前流程图，开始设计改动…', ts: 't2' },
  ];
  const bridge = {
    ...noopBridge,
    assistProgress: (id, since) => {
      assert.equal(id, 'as-1');
      return { events: all.filter((e) => e.seq > (since || 0)), done: false };
    },
  };
  const handler = mount(stubStore, bridge);
  const res = fakeRes();
  await handler(fakeReq('GET', '/assist/progress?id=as-1&since=1'), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.events.map((e) => e.seq), [2], 'since 之后的事件才返回');
  assert.equal(res.body.done, false);
});

test('GET /assist/progress: 完成后返回 done + result（reply/workflow/applied/rejected/childId）', async () => {
  const bridge = {
    ...noopBridge,
    assistProgress: () => ({
      events: [{ seq: 3, kind: 'done', text: '完成', ts: 't3' }],
      done: true,
      result: {
        reply: '已加验证节点',
        workflow: wf(),
        applied: [{ action: 'add_node', nodeId: 'verify' }],
        rejected: [],
        childId: 'child-9',
        elapsedMs: 1234,
      },
    }),
  };
  const handler = mount(stubStore, bridge);
  const res = fakeRes();
  await handler(fakeReq('GET', '/assist/progress?id=as-1'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.done, true);
  assert.equal(res.body.result.reply, '已加验证节点');
  assert.equal(res.body.result.childId, 'child-9', '应带助手 subagent 会话 id 供前端跳转');
  assert.ok(Array.isArray(res.body.result.applied));
});

test('GET /assist/progress: 未知 id → 404', async () => {
  const bridge = { ...noopBridge, assistProgress: () => null };
  const handler = mount(stubStore, bridge);
  const res = fakeRes();
  await handler(fakeReq('GET', '/assist/progress?id=nope'), res);
  assert.equal(res.statusCode, 404);
});

test('POST /assist: 缺 workflow / message → 400', async () => {
  const handler = mount(stubStore, { ...noopBridge, startAssist: () => ({ requestId: 'x' }) });
  const r1 = fakeRes();
  await handler(fakeReq('POST', '/assist', { message: 'x' }), r1);
  assert.equal(r1.statusCode, 400);
  const r2 = fakeRes();
  await handler(fakeReq('POST', '/assist', { workflow: wf() }), r2);
  assert.equal(r2.statusCode, 400);
});

test('POST /assist: 启动失败（无活跃会话/引擎不可用）→ 500 带可读 message', async () => {
  const bridge = {
    ...noopBridge,
    startAssist: () => { throw new Error('workflowEngine unavailable in the owning agent scope'); },
  };
  const handler = mount(stubStore, bridge);
  const res = fakeRes();
  await handler(fakeReq('POST', '/assist', { workflow: wf(), message: 'x' }), res);
  assert.equal(res.statusCode, 500);
  assert.match(String(res.body.error || ''), /workflowEngine|unavailable/);
});

