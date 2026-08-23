/**
 * dsh-knj-workflow 图编排器脚本（workflow 工具执行体）
 * ---------------------------------------------------------------
 * 图遍历：从 start 开始逐节点执行——
 *   - task 节点：派子 agent 执行 body.prompt，产出结构化结果写入 ctx
 *   - gateway-xor：按 when 条件路由（default 兜底）
 *   - gateway-and：split（多出边）并行执行分支，join（多入边）等全部完成；
 *                  某分支失败 → 整体失败（严格）
 *   - human：暂停，返回 null 等待人工决策（后续小步）
 *
 * 输入 args：
 *   config - 工作流定义 { id, name, inputs, nodes: [...], edges: [...] }
 *   task   - 任务元数据 { id, title, taskDir }
 *
 * 断点持久化：每个 task 节点完成后，子 agent 把结构化结果写入
 *   <taskDir>/stages/<nodeId>.json（子 agent 通过 write 工具落盘）。
 *
 * 注意：本脚本运行在 workflow 引擎沙箱，无 fs/network/require，
 * 因此路由/数据流逻辑内联（与 lib/graph.js 语义一致，勿偏离）。
 */

const cfg = args.config;
if (!cfg || !Array.isArray(cfg.nodes) || !Array.isArray(cfg.edges)) {
  throw new Error('args.config 必须是 { nodes: [...], edges: [...] }');
}
const task = args.task || { id: 'task', taskDir: '.tasks/knj' };
const stageDir = `${String(task.taskDir || '').replace(/\/+$/, '')}/stages`;

const byId = new Map(cfg.nodes.map((n) => [n.id, n]));
const results = { ...(args.initialResults || {}) };   // ctx: nodeId -> output（断点恢复）
const skipSet = new Set(Object.keys(args.initialResults || {})); // 断点恢复时跳过的节点
const stageLog = [];
const runCount = new Map(); // nodeId -> 本轮已执行次数（节点级 maxRuns 保护，防死循环）
let humanFeedback = null;   // 人工意见：注入去向目标节点（仅一次）
// 历史决策重放：{ humanId: label }。resume/decide 重走图时，已审批过的 human 不再暂停，
// 直接走其最后去向（目标已在 initialResults 则被 skipSet 跳过；否则正常执行）。
// 没有它，两个顺序 human 的任务会在 H1/H2 之间无限振荡（H2 的决策被 H1 的重新暂停吞掉）。
const decidedMap = args.decided || {};

/** 节点最大执行次数：显式配置 maxRuns 优先，默认 3（首次 + 最多 2 次重跑）。 */
function maxRunsOf(node) {
  const m = Number(node && node.maxRuns);
  return Number.isInteger(m) && m >= 1 ? m : 3;
}

/** 执行前检查并登记一次执行：超过 maxRuns 直接抛错（不浪费 subagent）。 */
function countRun(node) {
  const n = (runCount.get(node.id) || 0) + 1;
  if (n > maxRunsOf(node)) {
    throw new Error(`节点「${node.title || node.id}」本轮执行 ${n} 次，超过上限 ${maxRunsOf(node)}（疑似死循环，请检查连线）`);
  }
  runCount.set(node.id, n);
}

/** 人工节点去向：优先 routes（多去向：label + to），兼容旧 approveTo/rejectTo（推导为 通过/驳回 两条）。 */
function humanRoutes(node) {
  if (Array.isArray(node.routes) && node.routes.length > 0) return node.routes;
  const r = [];
  if (node.approveTo) r.push({ label: '通过', to: node.approveTo, tone: 'success' });
  if (node.rejectTo) r.push({ label: '驳回', to: node.rejectTo, tone: 'danger' });
  return r;
}

/** 决策值 → 去向：兼容旧值 approve/reject（映射 通过/驳回）；不在列表/目标无效直接抛错。 */
function matchRoute(node, rawValue) {
  const routes = humanRoutes(node);
  let value = rawValue;
  if (value === 'approve') value = '通过';
  else if (value === 'reject') value = '驳回';
  const route = routes.find((r) => r.label === value);
  if (!route) {
    throw new Error(`人工节点「${node.title || node.id}」决策「${rawValue}」不在去向列表（${routes.map((r) => r.label).join(' / ') || '未配置'}）`);
  }
  if (!route.to || !byId.has(route.to)) throw new Error(`人工节点「${node.title || node.id}」的「${route.label}」去向无效: ${route.to}`);
  return route;
}

// ---- 内联自 lib/graph.js（沙箱无法 require）----
/**
 * 条件字段 field 三种写法：
 * - 裸字段名（如 level）→ 相对作用域：XOR 唯一上游输出 / task 多出边自身输出
 * - ${节点id.字段}（如 ${verify.passed}）→ 显式引用任意已执行节点/任务变量（与 prompt 引用语法一致，取原始值）
 * - 裸点号路径（如 verify.passed）→ 同上，按全局引用解析
 */
function matchCondition(upstream, when) {
  if (!when || !when.field) return false;
  const f = String(when.field);
  let v;
  if (f.startsWith('${') && f.endsWith('}')) v = resolveRefRaw(f.slice(2, -1));
  else if (f.indexOf('.') >= 0) v = resolveRefRaw(f);
  else v = upstream[f];
  if (when.op === 'eq') return looseEq(v, when.value);
  if (when.op === 'neq') return !looseEq(v, when.value);
  if (when.op === 'in') return Array.isArray(when.value) && when.value.some((x) => looseEq(v, x));
  return false;
}

/** 宽松相等：真值优先严格比较；兼容旧配置存的字符串值（'true'↔true、'5'↔5）。 */
function looseEq(a, b) {
  if (a === b) return true;
  if (typeof b === 'string') {
    if (a === true && b === 'true') return true;
    if (a === false && b === 'false') return true;
    if (typeof a === 'number' && b !== '' && !isNaN(Number(b)) && Number(b) === a) return true;
  }
  return false;
}

/** 路由：单出口节点返回唯一出边；多出边（XOR 网关）按 when 条件路由。死循环由节点级 maxRuns 保护（见 countRun）。 */
function nextNode(nodeId) {
  const node = byId.get(nodeId);
  if (!node) throw new Error(`节点不存在: ${nodeId}`);
  const out = cfg.edges.filter((e) => e.from === nodeId);
  if (node.type === 'human') return null;

  // when.field 作用域：XOR 网关相对唯一上游；task 多出边相对自身输出
  let upstream;
  if (node.type === 'gateway-xor') {
    const inEdge = cfg.edges.find((e) => e.to === nodeId);
    upstream = inEdge ? (results[inEdge.from] || {}) : {};
  } else {
    upstream = results[nodeId] || {};
  }

  let chosen = null;
  if (out.length > 1) {
    for (const e of out) {
      // default 边：配了条件也参与匹配（兜底优先级的条件边）；无条件则纯兜底，跳过匹配
      if (e.default && !e.when) continue;
      if (e.when) {
        // 条件值支持引用任务变量（${ctx.inputs.x} / ${inputDescription} 等），如按输入分流
        const wVal = typeof e.when.value === 'string' ? resolveRefs(e.when.value) : e.when.value;
        if (matchCondition(upstream, { ...e.when, value: wVal })) { chosen = e; break; }
      }
    }
    // 所有条件都没命中 → 优先走无条件 default（纯兜底）；没有则走第一条 default（带条件也兜底）
    if (!chosen) chosen = out.find((e) => e.default && !e.when) || out.find((e) => e.default) || null;
    if (!chosen) throw new Error(`节点 ${nodeId} 无匹配条件且无 default 边`);
  } else if (out.length === 1) {
    chosen = out[0];
  } else {
    // 零出边：仅 end 合法（正常结束）；task/start 断头静默当成功会掩盖配置错误
    if (node.type === 'end') return null;
    throw new Error(`节点「${node.title || nodeId}」没有出边（流程在此断头，请补连线到 end）`);
  }

  return chosen.to;
}

/** 从 split 网关出边 BFS，找第一个多入边的 gateway-and（即对应 join）。 */
function findJoin(splitId) {
  const seen = new Set([splitId]);
  const queue = cfg.edges.filter((e) => e.from === splitId).map((e) => e.to);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node.type === 'gateway-and') {
      const inN = cfg.edges.filter((e) => e.to === id).length;
      if (inN > 1) return id;
    }
    for (const e of cfg.edges.filter((e) => e.from === id)) queue.push(e.to);
  }
  return null;
}
// ----------------------------------------------------

// ---- hook：内置动作库 + 动作执行（内联，勿偏离 lib/actions.js 语义）----
const BUILTIN_ACTIONS = {
  'git-pull': { prompt: '用 bash 工具执行 git pull，返回 { ok, branch, commit }', schema: null },
  'git-checkout': { prompt: '用 bash 工具执行 git checkout {branch}，返回 { ok, commit }', schema: null },
  'mkdir': { prompt: '用 bash 工具创建目录 {path}，返回 { ok, path }', schema: null },
  'write-product': { prompt: '用 write 工具把产物内容写入文件 {path}（UTF-8）', schema: null },
};

function getCtx() {
  // 任务级变量：inputDescription（新建任务需求描述）、inputTitle（标题）、storyCode（用户故事编码）、
  // cwd（工作目录）、inputs（参数映射）并列，工作流任意 prompt/hook 参数可引用。
  return {
    inputs: args.inputs || {},
    inputDescription: task.description || '',
    inputTitle: task.title || '',
    storyCode: task.storyCode || '',
    cwd: task.cwd || '',
    ...results
  };
}

/** 解析引用：${inputDescription}（任务级）、${节点id.字段}（上游输出）、${ctx.路径}（兼容旧写法）。 */
function resolveRefs(text) {
  let s = String(text);
  // 统一正则：${路径} 或 ${ctx.路径}——路径按 getCtx 的 key 贪心匹配（inputDescription / inputs.x / 节点id.字段）
  s = s.replace(/\$\{(?:ctx\.)?([^}]+)\}/g, (m, path) => {
    const v = resolveRefRaw(path);
    // 找不到（XOR 分支被跳过的节点、拼写错误）→ 解析为空，避免把 ${...} 原文留在 prompt
    return v != null ? (typeof v === 'string' ? v : JSON.stringify(v)) : '';
  });
  return s;
}

/** 引用解析（原始值版）：返回不字符串化的真值。条件判断布尔/数字字段需要它（true !== "true"）。 */
function resolveRefRaw(path) {
  const ctx = getCtx();
  const parts = String(path).split('.');
  for (let i = parts.length; i >= 1; i--) {
    const key = parts.slice(0, i).join('.');
    if (key in ctx) {
      let val = ctx[key];
      for (let j = i; j < parts.length; j++) val = val == null ? val : val[parts[j]];
      return val;
    }
  }
  return undefined;
}

function fillTemplate(tpl, params) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
}

/** 执行一个 hook 动作（builtin 或 exec），输出按 as 命名写进 ctx。 */
async function runAction(node, action) {
  let prompt, schema, label;
  if (action.type === 'builtin') {
    const def = BUILTIN_ACTIONS[action.name];
    if (!def) throw new Error(`未知内置动作: ${action.name}`);
    prompt = resolveRefs(fillTemplate(def.prompt, action.params || {}));
    schema = def.schema;
    label = `${node.title}:${action.name}`;
  } else {
    prompt = resolveRefs(action.prompt || '');
    schema = action.output && action.output.type ? action.output : null;
    label = `${node.title}:exec`;
  }
  const opts = { label, phase: node.id };
  if (schema) opts.schema = schema;
  const out = await agent(prompt, opts);
  if (action.as) results[`${node.id}.${action.as}`] = out;
  return out;
}
// ----------------------------------------------------

/** 执行从 nodeId 到 joinId（或 end）的路径，返回 { ok, current }。 */
async function executeUntil(nodeId, joinId) {
  let current = nodeId;
  let ok = true;
  let safety = 0;
  while (current && current !== 'end' && current !== joinId && safety < 1000) {
    safety++;
    const node = byId.get(current);
    if (!node) throw new Error(`节点不存在: ${current}`);
    // phase 传 node.id（而非 title）：stageStates 按 id 匹配，重名节点不会错标
    phase(node.id);

    if (node.type === 'task') {
      // 断点恢复：initialResults 里的节点跳过一次（后续重跑可重新执行）
      if (skipSet.has(node.id)) {
        skipSet.delete(node.id);
        current = nextNode(current);
        continue;
      }
      // 节点最大执行次数保护（默认 3）：超过即失败，防死循环。并行分片按一轮计 1 次。
      countRun(node);
      // 1. prehook 动作序列
      for (const action of node.prehook || []) {
        await runAction(node, action);
      }
      // 2. 主体
      // 干净 prompt：不自动注入 [任务需求]/[上游节点输出]/[skill]，需要时显式写 ${inputDescription} 等引用。
      // 自动保留两处执行环境信息：人工意见（去向目标节点需要知道）、工作目录（subagent 必须知道自己在哪执行文件/命令操作）。
      const parts = [];
      if (humanFeedback) {
        parts.push(`[人工意见]\n${humanFeedback}`);
        humanFeedback = null;
      }
      // 工作目录声明：所有文件读写与命令执行都在该目录下进行（仅当任务指定了工作区）
      if (task.cwd) parts.push(`[工作目录]\n${task.cwd}\n（你的所有文件读写与命令执行都必须在上述工作目录内进行）`);
      // 主体 prompt 解析 ${ctx.xxx} 引用（任务输入 / 上游输出 / 动作输出 / ${cwd} 工作目录）。
      parts.push(resolveRefs((node.body && node.body.prompt) || ''));
      let prompt = parts.join('\n\n');
      const writeInstr = `\n\n完成后，用 write 工具将你的结构化输出写入文件 ${stageDir}/${node.id}.json（UTF-8 JSON）。`;

      const opts = { label: node.title, phase: node.id };
      const outSchema = node.body && node.body.output;
      if (outSchema && outSchema.type) opts.schema = outSchema;

      const isParallel = node.body && node.body.mode === 'parallel';
      if (isParallel) {
        // 节点级并行：派 N 个 subagent 执行同一 prompt，结果合并成数组（各自写不同 stage 文件）
        const n = Math.max(1, node.body.parallelItems || 3);
        const thunks = [];
        for (let i = 0; i < n; i++) {
          const instr = writeInstr.replace(`${node.id}.json`, `${node.id}-${i + 1}.json`);
          thunks.push(() => agent(prompt + instr, { ...opts, label: `${node.title} #${i + 1}`, phase: node.id }));
        }
        const outputs = await parallel(thunks);
        const valid = (outputs || []).filter((o) => o !== null && o !== undefined);
        if (valid.length === 0) throw new Error(`节点「${node.title}」并行执行失败（无有效输出）`);
        results[node.id] = valid;
        stageLog.push({ id: node.id, title: node.title, ok: true });
      } else {
        const output = await agent(prompt + writeInstr, opts);
        results[node.id] = output;
        stageLog.push({ id: node.id, title: node.title, ok: output !== null });
        if (output === null) throw new Error(`节点「${node.title}」执行失败（subagent 无有效输出）`);
      }
      // 断点：节点成功后主动上报结果，Host 落盘 stages/<nodeId>.json，
      // 取消/中断后 resume 用它们跳过已完成节点（subagent 常不遵守写文件指令，不能依赖它）。
      try { log('[knj-checkpoint]' + JSON.stringify({ node: node.id, output: results[node.id] })); } catch {}
      log(`节点 ${node.title} 结束`);
      // 3. posthook 动作序列
      for (const action of node.posthook || []) {
        await runAction(node, action);
      }
      current = nextNode(current);
    } else if (node.type === 'gateway-and' && cfg.edges.filter((e) => e.from === current).length > 1) {
      // split：并行执行所有分支到 join
      const nestedJoin = findJoin(current);
      const branches = cfg.edges
        .filter((e) => e.from === current)
        .map((e) => () => executeUntil(e.to, nestedJoin));
      const branchResults = await parallel(branches);
      if (branchResults.some((r) => !r || r.ok === false)) throw new Error(`并行分支执行失败（节点「${current}」）`);
      // 分支内 human 暂停必须向上传播，否则审批被静默吞掉、工作流"成功"完成
      const pausedBranch = branchResults.find((r) => r && r.paused);
      if (pausedBranch) return { ok: true, current: null, paused: true, pausedAt: pausedBranch.pausedAt };
      current = nestedJoin ? nextNode(nestedJoin) : null;
    } else if (node.type === 'human') {
      // 人工节点：本轮决策优先（decide/continue 触发），其次历史决策重放（已审批过的不再暂停）
      if (args.decision && args.decision.humanId === node.id) {
        const decision = args.decision;
        args.decision = null; // 消费决策：去向指回本节点的回边图若重复应用会无限循环直到 AGENT_CAP
        const route = matchRoute(node, decision.value);
        if (decision.feedback) humanFeedback = decision.feedback;
        skipSet.delete(route.to); // 去向目标应重新执行（接受人工意见），避免被断点跳过
        current = route.to;
      } else if (decidedMap[node.id]) {
        // 历史决策重放：这个 human 已审批过（如顺序两个 human，后一个决策触发 resume 重走图）。
        // 直接走最后去向：目标已在 initialResults → skipSet 跳过；未执行过 → 正常执行。
        // 不注入意见（当初决策后的执行已带过意见）。
        const route = matchRoute(node, decidedMap[node.id]);
        current = route.to;
      } else {
        return { ok: true, current: null, paused: true, pausedAt: node.id };
      }
    } else {
      current = nextNode(current);
    }
  }
  return { ok, current };
}

// 所有执行失败（节点 subagent 无输出 / 并行分支失败 / 循环超限）都在 executeUntil 内抛错，
// 这里不吞错、直接向外抛：脚本正常 return 会被 workflow engine 判 stopReason=completed，
// 导致失败任务被误标 success。
const r = await executeUntil('start', null);

return {
  workflow: cfg.id || cfg.name || 'workflow',
  taskId: task.id,
  nodeCount: cfg.nodes.length,
  stageLog,
  results,
  ok: r.ok,
  current: r.current, // 'end' 正常结束；null 表示暂停（human）
  ...(r.paused ? { paused: r.paused, pausedAt: r.pausedAt } : {}),
  ...(r.error ? { error: r.error } : {}),
};
