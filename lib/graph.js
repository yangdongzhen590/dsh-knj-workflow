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

/** 宽松相等：真值优先严格比较；兼容旧配置存的字符串值（'true'↔true、'5'↔5）。
 *  注意双向：subagent 输出可能是字符串化的数字/布尔（"5"/"true"），
 *  条件值也可能是数字/布尔（新版 UI 保存时智能转换）——任意一侧为字符串都要能宽松匹配。 */
function looseEq(a, b) {
  if (a === b) return true;
  // 布尔 ↔ 'true'/'false'（任意一侧字符串）
  if (a === true && b === 'true') return true;
  if (a === false && b === 'false') return true;
  if (b === true && a === 'true') return true;
  if (b === false && a === 'false') return true;
  // 数字 ↔ 数字字符串（"5"↔5，任意一侧字符串）
  if (typeof a === 'number' && typeof b === 'string') return b !== '' && !isNaN(Number(b)) && Number(b) === a;
  if (typeof b === 'number' && typeof a === 'string') return a !== '' && !isNaN(Number(a)) && Number(a) === b;
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

/**
 * 把 task 节点按图的拓扑执行顺序排列（从 start 出发沿边 BFS）。
 * 用途：任务 stageStates 的展示顺序应反映流程走向（如 task1 → task11 → task2 → task3），
 * 而不是 nodes 数组的声明顺序（节点在画布上的添加顺序可能与连线顺序不一致）。
 * 规则：
 *  - 只排 type === 'task' 的节点；start/end/gateway/human 不进入列表但参与连线拓扑。
 *  - human 节点的去向 routes（或旧 approveTo/rejectTo）视为虚拟出边参与排序——
 *    否则 human 后续的 task 会因「无真实出边」排到列表尾部（与执行顺序不符）。
 *  - XOR/AND 网关多出边按声明顺序稳定排列（同一网关后的分支保持 edges 顺序）。
 *  - 有环（驳回重跑等）时以 BFS 先到为准，环内节点不会导致死循环。
 * 返回：task 节点 id 数组（按拓扑序）。
 */
export function orderTaskNodesByFlow(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // 邻接表：真实边 + human 虚拟出边（routes / approveTo / rejectTo）
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (e?.from && byId.has(e.from) && e.to && byId.has(e.to)) adj.get(e.from).push(e.to);
  }
  for (const n of nodes) {
    if (n.type !== 'human') continue;
    for (const r of humanRoutes(n)) {
      if (r?.to && byId.has(r.to)) adj.get(n.id).push(r.to);
    }
  }
  // BFS 从 start 出发，记录 task 节点首次出现顺序
  const ordered = [];
  const seen = new Set();
  const queue = ['start'];
  seen.add('start');
  while (queue.length) {
    const id = queue.shift();
    const node = byId.get(id);
    if (node && node.type === 'task') ordered.push(id);
    for (const to of adj.get(id) || []) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  // 未被 start 可达（孤立/异常图）的 task 按声明顺序补尾，避免丢失
  for (const n of nodes) {
    if (n.type === 'task' && !seen.has(n.id)) ordered.push(n.id);
  }
  return ordered;
}

/**
 * 运行态图状态推导：把一次任务实例（stageStates + 任务级状态）映射到 workflow 的每个节点上，
 * 供「运行效果图」视图渲染。stageStates 只覆盖 task 类执行节点（实测 start/human/gateway/end
 * 不在其中），这里补全推导：
 *  - task：直接取 stage 状态；无 stage 兜底 pending
 *  - start：任务已启动（非 pending）→ 'passed'
 *  - human：waiting-human 且 humanState.humanId 命中 → 'waiting'；任务 success → 'done'；否则 'pending'
 *  - gateway：任一后继（edges / human routes）处于已执行态（done/failed/running/skipped/waiting）→ 'passed'
 *  - end：任务 success → 'done'；否则 'pending'
 * 返回 { nodeId: status }（status 取值与 stageStates 一致，另加 'passed' / 'waiting' 两个展示态）。
 */
export function deriveRunGraphStates(workflow, stageStates, task) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stages = Array.isArray(stageStates) ? stageStates : [];
  const stageOf = new Map(stages.map((s) => [s.id, s]));
  const taskStatus = task?.status;
  const humanWaiting = taskStatus === 'waiting-human' ? task?.humanState?.humanId : null;
  const executed = new Set();
  for (const s of stages) {
    if (['done', 'failed', 'running', 'skipped'].includes(s.status)) executed.add(s.id);
  }
  if (humanWaiting) executed.add(humanWaiting);
  // 后继集合（edges + human routes），网关判定用
  const successors = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (e?.from && byId.has(e.from) && e.to && byId.has(e.to)) successors.get(e.from).push(e.to);
  }
  for (const n of nodes) {
    if (n.type !== 'human') continue;
    for (const r of humanRoutes(n)) {
      if (r?.to && byId.has(r.to)) successors.get(n.id).push(r.to);
    }
  }
  const out = {};
  for (const n of nodes) {
    const id = n.id;
    if (stageOf.has(id)) { out[id] = stageOf.get(id).status; continue; }
    if (n.type === 'start') { out[id] = taskStatus && taskStatus !== 'pending' ? 'passed' : 'pending'; continue; }
    if (n.type === 'end') { out[id] = taskStatus === 'success' ? 'done' : 'pending'; continue; }
    if (n.type === 'human') {
      if (id === humanWaiting) out[id] = 'waiting';
      else if (taskStatus === 'success') out[id] = 'done';
      else out[id] = 'pending';
      continue;
    }
    if (n.type === 'gateway-xor' || n.type === 'gateway-and') {
      const reached = (successors.get(id) || []).some((to) => executed.has(to));
      out[id] = reached ? 'passed' : 'pending';
      continue;
    }
    out[id] = 'pending';
  }
  return out;
}

/**
 * 连线避让骨架（决策层，返回折点序列）：直线/贝塞尔可能从中间节点卡片上穿过（被卡片遮挡），
 * 这里算出「不穿卡」的正交骨架折点；最终由 roundedOrthoPath 圆滑成曲线观感。
 * obstacles：除两端点外的其它节点，形如 { x, y, hx, hy }（卡片中心与半宽/半高，含留白）。
 * 策略：同层直路畅通→2 点；否则 3 段（竖列避卡）；走廊被同层卡堵死时 V-H-V 带翻越（上下包抄）。
 * 返回 { pts, midX, midY }：折点数组（首尾为端口）、标签建议位置。
 */
export function routeEdgeKnee(sx, sy, tx, ty, obstacles = []) {
  const clearH = (y, x0, x1) => {
    const a = Math.min(x0, x1) + 3, b = Math.max(x0, x1) - 3;
    if (b - a < 8) return true;
    return !obstacles.some((o) => y >= o.y - o.hy && y <= o.y + o.hy && o.x - o.hx < b && o.x + o.hx > a);
  };
  const clearV = (x, y0, y1) => {
    const a = Math.min(y0, y1), b = Math.max(y0, y1);
    return !obstacles.some((o) => o.x - o.hx < x && o.x + o.hx > x && o.y - o.hy < b && o.y + o.hy > a);
  };
  const x0 = Math.min(sx, tx), x1 = Math.max(sx, tx);
  if (Math.abs(sy - ty) < 4 && clearH(sy, sx, tx)) {
    return { pts: [[sx, sy], [tx, ty]], midX: (sx + tx) / 2, midY: sy };
  }
  for (let x = x1 - 46; x >= x0 + 46; x -= 10) {
    if (!clearV(x, sy, ty)) continue;
    if (!clearH(sy, sx, x)) continue;
    if (!clearH(ty, x, tx)) continue;
    return { pts: [[sx, sy], [x, sy], [x, ty], [tx, ty]], midX: (x + tx) / 2, midY: ty };
  }
  const gaps = [];
  for (let dy = 60; dy <= 150; dy += 30) gaps.push(sy - dy, sy + dy);
  for (const y2 of gaps) {
    if (!clearH(y2, sx, tx)) continue;
    if (!clearV(sx, sy, y2)) continue;
    if (!clearV(tx, y2, ty)) continue;
    return { pts: [[sx, sy], [sx, y2], [tx, y2], [tx, ty]], midX: (sx + tx) / 2, midY: y2 };
  }
  const X = Math.round((x0 + x1) / 2);
  return { pts: [[sx, sy], [X, sy], [X, ty], [tx, ty]], midX: (X + tx) / 2, midY: ty };
}

/** 正交骨架圆滑成路径：每个 90° 转角用二次贝塞尔（Q）过渡，r 为圆角半径。 */
export function roundedOrthoPath(pts, r = 11) {
  if (!pts || pts.length < 2) return '';
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const dx1 = p1[0] - p0[0], dy1 = p1[1] - p0[1];
    const dx2 = p2[0] - p1[0], dy2 = p2[1] - p1[1];
    const len1 = Math.abs(dx1) + Math.abs(dy1);
    const len2 = Math.abs(dx2) + Math.abs(dy2);
    const rr = Math.max(2, Math.min(r, len1 / 2, len2 / 2));
    const inX = p1[0] - (dx1 !== 0 ? Math.sign(dx1) * rr : 0);
    const inY = p1[1] - (dy1 !== 0 ? Math.sign(dy1) * rr : 0);
    const outX = p1[0] + (dx2 !== 0 ? Math.sign(dx2) * rr : 0);
    const outY = p1[1] + (dy2 !== 0 ? Math.sign(dy2) * rr : 0);
    d += ` L ${inX} ${inY} Q ${p1[0]} ${p1[1]} ${outX} ${outY}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}

/** 智能平滑曲线：骨架点（已避让）用 Catmull-Rom 三次贝塞尔样条穿过，端口处水平进出。
 *  得到一条连续流动曲线（无直线段、无直角），观感接近直接贝塞尔但沿避让走廊走。 */
export function smoothCurvePath(pts, extend = 26) {
  if (!pts || pts.length < 2) return '';
  if (pts.length === 2) return `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]}`;
  const p0 = pts[0], pn = pts[pts.length - 1];
  const all = [[p0[0] - extend, p0[1]], ...pts, [pn[0] + extend, pn[1]]];
  let d = `M ${p0[0]} ${p0[1]}`;
  for (let i = 0; i < all.length - 3; i++) {
    const A = all[i], B = all[i + 1], C2 = all[i + 2], D = all[i + 3];
    const c1x = B[0] + (C2[0] - A[0]) / 6, c1y = B[1] + (C2[1] - A[1]) / 6;
    const c2x = C2[0] - (D[0] - B[0]) / 6, c2y = C2[1] - (D[1] - B[1]) / 6;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${C2[0]} ${C2[1]}`;
  }
  return d;
}

/** 第一版 S 贝塞尔路径：横向连接水平出入，纵向连接垂直出入。 */
function classicCurveD(sx, sy, tx, ty) {
  if (Math.abs(tx - sx) >= Math.abs(ty - sy)) {
    const mx = (sx + tx) / 2;
    return { d: `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`, midX: mx, midY: (sy + ty) / 2 };
  }
  const my = (sy + ty) / 2;
  return { d: `M ${sx} ${sy} C ${sx} ${my}, ${tx} ${my}, ${tx} ${ty}`, midX: (sx + tx) / 2, midY: my };
}

/** 采样判定：直连 S 贝塞尔/横线是否会穿过任意障碍卡（留白已含在 hx/hy 内）。命中返回 true。 */
function curveHits(sx, sy, tx, ty, obstacles) {
  const horizontal = Math.abs(tx - sx) >= Math.abs(ty - sy);
  const mx = (sx + tx) / 2, my = (sy + ty) / 2;
  for (let k = 0; k <= 20; k++) {
    const t = k / 20;
    const u = 1 - t;
    const x = horizontal
      ? u * u * u * sx + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * tx
      : u * u * u * sx + 3 * u * u * t * sx + 3 * u * t * t * tx + t * t * t * tx;
    const y = horizontal
      ? u * u * u * sy + 3 * u * u * t * sy + 3 * u * t * t * ty + t * t * t * ty
      : u * u * u * sy + 3 * u * u * t * my + 3 * u * t * t * my + t * t * t * ty;
    for (const o of obstacles) {
      if (x >= o.x - o.hx && x <= o.x + o.hx && y >= o.y - o.hy && y <= o.y + o.hy) return true;
    }
  }
  return false;
}

/**
 * 连线路由总入口：直连优先（同层横线或第一版优雅 S 贝塞尔，采样确认不碰任何卡），
 * 真正被卡片阻挡时才走避让骨架（routeEdgeKnee）+ 平滑样条（smoothCurvePath）。
 * 返回 { d, midX, midY, ax, ay, dx, dy }：path、标签位置、末端落点 (ax,ay) 与末段方向单位向量
 * （供调用方在末端手工绘制箭头——SVG marker 在部分环境渲染不可靠）。
 */
export function routeEdge(sx, sy, tx, ty, obstacles = [], arrowL = 0) {
  const dirOf = (px, py) => {
    const dx = tx - px, dy = ty - py;
    const len = Math.hypot(dx, dy) || 1;
    return { ax: tx, ay: ty, dx: dx / len, dy: dy / len };
  };
  // 线终点回缩一个箭头长度：线连到箭头尾巴，尖端(ax,ay)仍在端口指向节点
  const tip = { ax: tx, ay: ty };
  // 直连判定：不穿卡即可直连（保持最初版本观感）
  if (!curveHits(sx, sy, tx, ty, obstacles)) {
    if (Math.abs(sy - ty) < 4) {
      const s = Math.sign(tx - sx) || 1;
      const ex = tx - s * arrowL;
      return { d: `M ${sx} ${sy} H ${ex}`, midX: (sx + ex) / 2, midY: sy, ax: tx, ay: ty, dx: s, dy: 0 };
    }
    const ddx = tx - sx, ddy = ty - sy;
    const len = Math.hypot(ddx, ddy) || 1;
    const ex = tx - (ddx / len) * arrowL, ey = ty - (ddy / len) * arrowL;
    const c = classicCurveD(sx, sy, ex, ey);
    return { ...c, ax: tx, ay: ty, dx: ddx / len, dy: ddy / len };
  }
  const knee = routeEdgeKnee(sx, sy, tx, ty, obstacles);
  const last = knee.pts[knee.pts.length - 1];
  const prev = knee.pts[knee.pts.length - 2];
  const sdx = last[0] - prev[0], sdy = last[1] - prev[1];
  const len = Math.hypot(sdx, sdy) || 1;
  const ex = last[0] - (sdx / len) * arrowL, ey = last[1] - (sdy / len) * arrowL;
  if (knee.pts.length === 2) {
    const s = Math.sign(last[0] - prev[0]) || 1;
    return { d: `M ${prev[0]} ${prev[1]} H ${ex}`, midX: knee.midX, midY: knee.midY, ax: tx, ay: ty, dx: s, dy: 0 };
  }
  const tailPts = knee.pts.map((p, i) => (i === knee.pts.length - 1 ? [ex, ey] : p));
  return { d: smoothCurvePath(tailPts), midX: knee.midX, midY: knee.midY, ax: tx, ay: ty, dx: sdx / len, dy: sdy / len };
}
