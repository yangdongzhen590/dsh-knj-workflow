/**
 * dsh-knj-workflow 图工作流纯函数（零依赖，Host 端与编排器脚本共用语义）
 * ---------------------------------------------------------------
 * validateWorkflow - 图结构校验（start/end、孤立节点、边、网关拓扑）
 * nextNode         - 路由：给定当前节点 + 上下文 → 下一步节点 id
 * resolveInputs    - 数据流：解析节点显式参数映射（inputs）
 *
 * 数据模型约定（见 WORKFLOW-DESIGN.md 第 6 节）：
 *   - 节点 type：start | end | task | gateway-xor | gateway-and | human
 *   - XOR 网关单入边多出边，when.field 相对唯一上游；至少一条 default 出边
 *   - AND 网关 split（多出单入）或 join（多入单出），不混合
 *   - human 节点路由由 routes（label + to 的多去向）决定，兼容旧 approveTo / rejectTo（不在 edges 上写 when）
 *   - ctx 形状：{ <nodeId>: { <field>: value } }
 */

const NODE_TYPES = new Set(['start', 'end', 'task', 'gateway-xor', 'gateway-and', 'human']);

/** 人工节点去向：routes 优先（多去向：label + to），兼容旧 approveTo/rejectTo（推导为 通过/驳回 两条）。 */
function humanRoutes(node) {
  if (Array.isArray(node.routes) && node.routes.length > 0) return node.routes;
  const r = [];
  if (node.approveTo) r.push({ label: '通过', to: node.approveTo });
  if (node.rejectTo) r.push({ label: '驳回', to: node.rejectTo });
  return r;
}

/** 从 split 出边 BFS 找第一个多入边 gateway-and（与 orchestrator.findJoin 同语义）。 */
function findJoin(edges, byId, splitId) {
  const seen = new Set([splitId]);
  const queue = edges.filter((e) => e.from === splitId).map((e) => e.to);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node && node.type === 'gateway-and') {
      const inN = edges.filter((e) => e.to === id).length;
      if (inN > 1) return id;
    }
    for (const e of edges.filter((e) => e.from === id)) queue.push(e.to);
  }
  return null;
}

/** split 的分支节点集合：从 split 出边 BFS，不越过 join（join 本身不属于分支）。 */
function branchNodes(edges, joinId, splitId) {
  const seen = new Set();
  const queue = edges.filter((e) => e.from === splitId).map((e) => e.to);
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id) || id === joinId) continue;
    seen.add(id);
    for (const e of edges.filter((e) => e.from === id)) queue.push(e.to);
  }
  return seen;
}

/**
 * 图结构校验。返回 { ok, errors[] }。
 */
export function validateWorkflow(workflow) {
  const errors = [];
  if (!workflow || typeof workflow !== 'object') {
    return { ok: false, errors: ['workflow 必须是对象'] };
  }
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];

  if (nodes.length === 0) errors.push('nodes 不能为空');

  const ids = new Set();
  const byId = new Map();
  for (const n of nodes) {
    if (!n || !n.id) { errors.push('存在缺少 id 的节点'); continue; }
    if (ids.has(n.id)) errors.push(`节点 id 重复: ${n.id}`);
    ids.add(n.id);
    byId.set(n.id, n);
    if (!NODE_TYPES.has(n.type)) errors.push(`节点 ${n.id} 的 type 非法: ${n.type}`);
  }

  // start / end 唯一
  const starts = nodes.filter((n) => n.type === 'start');
  const ends = nodes.filter((n) => n.type === 'end');
  if (starts.length !== 1) errors.push(`必须有且仅有一个 start（当前 ${starts.length} 个）`);
  if (ends.length !== 1) errors.push(`必须有且仅有一个 end（当前 ${ends.length} 个）`);

  // 度数统计（用于孤立节点 / 网关拓扑）。拓扑分析把 human 的去向当"虚拟边"计入：
  // 否则 join 的入度会因 route 不写 edges 而失真，findJoin/分支分析全部失效。
  const inDegree = new Map();
  const outDegree = new Map();
  for (const id of ids) { inDegree.set(id, 0); outDegree.set(id, 0); }
  const bump = (from, to) => {
    if (byId.has(from)) outDegree.set(from, (outDegree.get(from) || 0) + 1);
    if (byId.has(to)) inDegree.set(to, (inDegree.get(to) || 0) + 1);
  };
  for (const e of edges) {
    if (!e || !e.from || !e.to) { errors.push('存在缺少 from/to 的边'); continue; }
    if (!byId.has(e.from)) errors.push(`边 from 指向不存在的节点: ${e.from}`);
    if (!byId.has(e.to)) errors.push(`边 to 指向不存在的节点: ${e.to}`);
    bump(e.from, e.to);
  }
  const humanRouteEdges = []; // human 去向虚拟边 {from: humanId, to: route.to}
  for (const n of nodes) {
    if (n.type !== 'human') continue;
    for (const r of humanRoutes(n)) {
      if (r.to) { humanRouteEdges.push({ from: n.id, to: r.to }); bump(n.id, r.to); }
    }
  }
  // 拓扑分析统一用 edges + human 虚拟边（节点级校验仍按原始 edges）
  const topoEdges = edges.filter((e) => e && e.from && e.to).concat(humanRouteEdges);

  // 孤立节点：除 start 外无入边（human 虚拟边已计入入度，无需额外豁免）
  for (const n of nodes) {
    if (n.type === 'start') continue; // start 无入边正常
    if ((inDegree.get(n.id) || 0) === 0) errors.push(`节点 ${n.id} 无入边（孤立）`);
  }

  // 网关拓扑 / 人工节点去向 / 边规范化
  const edgePairs = new Set();
  for (const e of edges) {
    if (!e || !e.from || !e.to) continue;
    const k = e.from + '->' + e.to;
    if (edgePairs.has(k)) errors.push(`重复边: ${e.from} → ${e.to}（同一对节点只能有一条连线）`);
    edgePairs.add(k);
  }
  for (const n of nodes) {
    if (n.type === 'gateway-xor') {
      const out = edges.filter((e) => e.from === n.id);
      if (out.length < 2) { errors.push(`排他网关 ${n.id} 出边数不足（需 ≥2）`); continue; }
      if (!out.some((e) => e.default)) errors.push(`排他网关 ${n.id} 缺少 default 出边`);
      const dead = out.filter((e) => !e.default && !(e.when && e.when.field));
      if (dead.length) errors.push(`排他网关 ${n.id} 有 ${dead.length} 条出边既非默认也未配条件（永远不会命中）`);
    }
    // task 多出边 = 分支路由（与网关同一套 when/default 语义）：非默认边必须配条件
    if (n.type === 'task') {
      const out = edges.filter((e) => e.from === n.id);
      if (out.length > 1) {
        const dead = out.filter((e) => !e.default && !(e.when && e.when.field));
        if (dead.length) errors.push(`节点 ${n.id} 有多条出边，其中 ${dead.length} 条既非默认也未配条件（永远不会命中）`);
      }
    }
    if (n.type === 'gateway-and') {
      const inN = inDegree.get(n.id) || 0;
      const outN = outDegree.get(n.id) || 0;
      const isSplit = outN > 1 && inN <= 1;
      const isJoin = inN > 1 && outN <= 1;
      if (!isSplit && !isJoin) {
        errors.push(`并行网关 ${n.id} 拓扑非法：必须 split（多出单入）或 join（多入单出）`);
      }
      // 并行分支内不允许人工节点：human 的去向不写 edges（靠 routes），
      // 会破坏 join 的入度识别；且决策恢复时分支越过 join 会重复执行汇合后子图。
      // 人工审批请放在 join 之后（或串行流程中）。分析用 topoEdges（含 human 虚拟边）。
      if (isSplit) {
        const joinId = findJoin(topoEdges, byId, n.id);
        if (joinId) {
          const branch = branchNodes(topoEdges, joinId, n.id);
          for (const m of nodes) {
            if (m.type === 'human' && branch.has(m.id)) {
              errors.push(`人工节点 ${m.id} 不能放在并行分支内（去向不参与 join 汇合度数统计，恢复执行会重复跑汇合后的节点）；请移到 join ${joinId} 之后`);
            }
          }
        }
      }
    }
    if (n.type === 'human') {
      const routes = humanRoutes(n);
      if (routes.length === 0) errors.push(`人工节点 ${n.id} 未配置任何去向（routes 或 approveTo/rejectTo）`);
      const labels = new Set();
      routes.forEach((r, i) => {
        if (!r.label) errors.push(`人工节点 ${n.id} 的第 ${i + 1} 个去向缺少标签`);
        else if (labels.has(r.label)) errors.push(`人工节点 ${n.id} 去向标签重复: ${r.label}`);
        labels.add(r.label);
        if (!r.to || !byId.has(r.to)) errors.push(`人工节点 ${n.id} 去向「${r.label || (i + 1)}」目标无效: ${r.to}`);
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/** 引用路径 → ctx 原始值（贪心匹配 key，不字符串化；与 orchestrator.resolveRefRaw 同语义）。 */
function refValue(ctx, path) {
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

/**
 * 评估结构化条件 when { field, op: eq|neq|in, value }。
 * field 三种写法：裸字段名（相对 upstream 作用域）、${节点id.字段}（全局引用，取原始值）、
 * 裸点号路径（verify.passed，按全局引用解析）。与 orchestrator.matchCondition 语义一致。
 */
function matchCondition(upstream, when, ctx) {
  if (!when || !when.field) return false;
  const f = String(when.field);
  let value;
  if (f.startsWith('${') && f.endsWith('}')) value = refValue(ctx || {}, f.slice(2, -1));
  else if (f.indexOf('.') >= 0) value = refValue(ctx || {}, f);
  else value = upstream[when.field];
  switch (when.op) {
    case 'eq': return looseEq(value, when.value);
    case 'neq': return !looseEq(value, when.value);
    case 'in': return Array.isArray(when.value) && when.value.some((x) => looseEq(value, x));
    default: return false;
  }
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

/**
 * 路由：给定当前节点 id + 上下文，返回下一个节点 id。
 * - 单出边节点：直接走唯一出边（不评估条件）
 * - 多出边节点（gateway-xor / task）：按 when 条件命中分支（最先命中生效）；
 *   default 边配了条件也参与匹配；兜底优先「无条件 default」，其次任一 default；无 default 抛错
 * - when.field 作用域：XOR 网关相对唯一上游输出；task 多出边相对自身输出；
 *   也支持 ${节点id.字段} 或裸点号路径（verify.passed）显式引用任意节点输出（取原始值）
 * - human 节点：返回 null（表示暂停，等待人工决策 routes）
 * 与 lib/orchestrator.js 内联实现语义一致，勿偏离。
 */
export function nextNode(workflow, nodeId, ctx = {}) {
  const nodes = workflow.nodes || [];
  const edges = workflow.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const node = byId.get(nodeId);
  if (!node) throw new Error(`节点不存在: ${nodeId}`);

  const outEdges = edges.filter((e) => e.from === nodeId);

  if (node.type === 'human') {
    return null; // 暂停等待人工决策
  }

  if (outEdges.length > 1) {
    const upstream = node.type === 'gateway-xor'
      ? (() => {
        const inEdge = edges.find((e) => e.to === nodeId);
        return inEdge ? (ctx[inEdge.from] || {}) : {};
      })()
      : (ctx[nodeId] || {}); // task 多出边：相对自身输出
    let chosen = null;
    for (const e of outEdges) {
      // default 边：配了条件也参与匹配（兜底优先级的条件边）；无条件则纯兜底，跳过匹配
      if (e.default && !e.when) continue;
      if (e.when && matchCondition(upstream, e.when, ctx)) { chosen = e; break; }
    }
    // 都没命中 → 优先无条件 default（纯兜底）；其次任一 default（带条件也兜底）
    if (!chosen) chosen = outEdges.find((e) => e.default && !e.when) || outEdges.find((e) => e.default) || null;
    if (!chosen) throw new Error(`节点 ${nodeId} 无匹配条件且无 default 边`);
    return chosen.to;
  }

  if (outEdges.length !== 1) {
    if (node.type === 'end') return null;
    throw new Error(`节点 ${nodeId} 出边数应为 1（当前 ${outEdges.length}）`);
  }
  return outEdges[0].to;
}

/**
 * 数据流：解析节点显式参数映射（inputs: [{from, field|"*"}]）。
 * 返回 { <from>: { <field>: value } }；字段/上游缺失抛错。
 */
export function resolveInputs(ctx, node) {
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  if (inputs.length === 0) return {};
  const result = {};
  for (const ref of inputs) {
    const src = ctx[ref.from];
    if (src === undefined) throw new Error(`上游节点 ${ref.from} 无输出`);
    if (ref.field === '*') {
      result[ref.from] = src;
    } else {
      if (!(ref.field in src)) throw new Error(`上游 ${ref.from} 缺少字段 ${ref.field}`);
      result[ref.from] = result[ref.from] || {};
      result[ref.from][ref.field] = src[ref.field];
    }
  }
  return result;
}

/**
 * 保存前准备：校验 + 写 schemaVersion + revision 递增。
 * 返回 { ok, errors? , workflow? }（纯函数，供 DevTaskStore.saveWorkflow 调用）。
 */
export function prepareWorkflowForSave(workflow, existing) {
  if (!workflow || !workflow.id) return { ok: false, errors: ['workflow.id required'] };
  const v = validateWorkflow(workflow);
  if (!v.ok) return { ok: false, errors: v.errors };
  workflow.schemaVersion = 2;
  workflow.revision = (existing?.revision || 0) + 1;
  return { ok: true, workflow };
}
