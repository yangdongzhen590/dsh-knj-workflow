/**
 * dsh-knj-workflow AI 助手编辑动作引擎（纯函数，零依赖）
 * ---------------------------------------------------------------
 * applyEdits(workflow, edits) —— 把 AI 助手返回的编辑动作序列可靠地应用
 * 到工作流草稿上，作为「对话配置工作流」的安全地基：
 *
 *   - 语义预检（动作级）：删 start/end、引用不存在的节点/边、重复边、
 *     set_node 写 x/y/id、set_meta 改 workflow.id、human routes 目标无效、
 *     未知动作类型 —— 单条 rejected（含原因），跳过该动作，其余合法动作继续；
 *   - 图结构终检（批级）：全部动作应用后跑一次 validateWorkflow。
 *       ok  → 返回 { workflow: 应用后, applied, rejected }
 *       !ok → 整批回滚：workflow = 原始（深拷贝）, applied = [], rejected 追记图错误
 *
 * 数据模型约定（与 lib/graph.js / orchestrator.js 一致，勿偏离）：
 *   workflow = { id, name, schemaVersion:2, inputs, nodes:[{id,type,title,...}], edges:[{from,to,when?,default?}] }
 *   节点 type：start | end | task | gateway-xor | gateway-and | human
 *   human 节点去向：routes（label + to）优先，兼容 approveTo/rejectTo
 *
 * AI 不允许：写 x/y 坐标（布局归 Client）、整体替换 workflow、修改 workflow.id。
 */

import { validateWorkflow } from './graph.js';

const NODE_TYPES = new Set(['start', 'end', 'task', 'gateway-xor', 'gateway-and', 'human']);
const KNOWN_ACTIONS = new Set([
  'add_node', 'set_node', 'remove_node',
  'add_edge', 'set_edge', 'remove_edge',
  'set_routes', 'set_meta',
]);
// set_node 允许写的节点字段白名单（AI 不可写布局坐标/内部类型/输入映射）
const NODE_PATCH_KEYS = new Set(['title', 'body', 'routes', 'approveTo', 'rejectTo', 'maxRuns', 'skill', 'description', 'displayFrom']);
// set_meta 允许写的顶层字段（id 是身份，绝不允许 AI 改）
const META_PATCH_KEYS = new Set(['name', 'description', 'inputs']);

/** 深拷贝辅助（JSON 往返即可，数据均为可序列化结构）。 */
function clone(x) { return JSON.parse(JSON.stringify(x)); }

/** 无 id 的 add_node：英文标题 → task-<slug>；否则 task-<随机 6 位>。 */
function autoNodeId(nodes, title, type) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug) {
    const base = `task-${slug}`;
    if (!nodes.some((n) => n.id === base)) return base;
    return `${base}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const t = type === 'task' ? 'task' : type;
  for (let i = 0; i < 20; i++) {
    const id = `${t}-${Math.random().toString(36).slice(2, 8)}`;
    if (!nodes.some((n) => n.id === id)) return id;
  }
  return `${t}-${Date.now().toString(36)}`;
}

/** 默认 task 节点形状：与 orchestrator/graph 约定对齐（inputs 依赖显式声明）。 */
function blankNode(id, type, title, extra) {
  const node = { id, type, title: title || '' };
  if (type === 'task') {
    node.inputs = [];
    node.body = { prompt: '', mode: 'single', output: {} };
  }
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) {
      if (k === 'id' || k === 'type' || k === 'x' || k === 'y') continue; // AI 不许直接写
      node[k] = clone(extra[k]);
    }
  }
  return node;
}

/** 动作语义预检（不含整图拓扑）。返回错误字符串；null 表示通过。 */
function precheck(workflow, action) {
  if (!action || typeof action !== 'object') return '动作必须是对象';
  const a = action.action;
  if (!KNOWN_ACTIONS.has(a)) return `未知动作类型: ${a}`;

  const { nodes, edges } = workflow;
  const hasNode = (id) => nodes.some((n) => n.id === id);
  const nodeType = (id) => (nodes.find((n) => n.id === id) || {}).type;
  const edgeKey = (from, to) => `${from}\u0000${to}`;
  const edgeSet = new Set(edges.map((e) => edgeKey(e.from, e.to)));

  switch (a) {
    case 'add_node': {
      const type = action.type;
      if (!NODE_TYPES.has(type)) return `add_node type 非法: ${type}`;
      if (action.id !== undefined && action.id !== null && action.id !== '') {
        if (typeof action.id !== 'string') return 'add_node id 必须是字符串';
        if (hasNode(action.id)) return `节点 id 已存在: ${action.id}`;
      }
      // routes 目标有效性（human）
      const routes = Array.isArray(action.routes) ? action.routes : [];
      for (const r of routes) {
        if (!r || !r.label) return `human 去向缺少标签`;
        if (r.to && !hasNode(r.to) && r.to !== action.id) return `human 去向「${r.label}」目标不存在: ${r.to}`;
      }
      return null;
    }
    case 'remove_node': {
      const id = action.id;
      if (!hasNode(id)) return `节点不存在: ${id}`;
      const t = nodeType(id);
      if (t === 'start' || t === 'end') return `节点 ${id} 是流程必需起止点（${t}），不能删除`;
      return null;
    }
    case 'set_node': {
      const id = action.id;
      if (!hasNode(id)) return `节点不存在: ${id}`;
      const t = nodeType(id);
      const bad = Object.keys(action.patch || {}).filter((k) => !NODE_PATCH_KEYS.has(k));
      if (bad.length) return `set_node 不允许写字段: ${bad.join(', ')}（坐标/类型/id 由系统管理）`;
      if (t !== 'human' && (action.patch?.routes || action.patch?.approveTo || action.patch?.rejectTo)) {
        return `仅 human 节点可配置去向（routes/approveTo/rejectTo）`;
      }
      return null;
    }
    case 'add_edge': {
      const from = action.from, to = action.to;
      if (!hasNode(from)) return `add_edge from 节点不存在: ${from}`;
      if (!hasNode(to)) return `add_edge to 节点不存在: ${to}`;
      if (edgeSet.has(edgeKey(from, to))) return `重复边（已存在连线）: ${from} → ${to}`;
      if (from === to) return `不允许自环边: ${from} → ${from}`;
      return null;
    }
    case 'remove_edge': {
      const from = action.from, to = action.to;
      if (!edgeSet.has(edgeKey(from, to))) return `边不存在: ${from} → ${to}`;
      return null;
    }
    case 'set_edge': {
      const from = action.from, to = action.to;
      if (!edgeSet.has(edgeKey(from, to))) return `边不存在: ${from} → ${to}`;
      const bad = Object.keys(action.patch || {}).filter((k) => !['when', 'default'].includes(k));
      if (bad.length) return `set_edge 不允许写字段: ${bad.join(', ')}（仅 when/default）`;
      return null;
    }
    case 'set_routes': {
      const id = action.id;
      if (!hasNode(id)) return `节点不存在: ${id}`;
      if (nodeType(id) !== 'human') return `仅 human 节点可配置去向（当前 ${nodeType(id)}）`;
      const routes = Array.isArray(action.routes) ? action.routes : [];
      if (routes.length === 0) return `human 节点 ${id} 至少需要一个去向`;
      const labels = new Set();
      for (const r of routes) {
        if (!r || !r.label) return `human 去向缺少标签`;
        if (labels.has(r.label)) return `human 去向标签重复: ${r.label}`;
        labels.add(r.label);
        if (!r.to || !hasNode(r.to)) return `human 去向「${r.label}」目标无效: ${r.to}`;
      }
      return null;
    }
    case 'set_meta': {
      const bad = Object.keys(action).filter((k) => k !== 'action' && !META_PATCH_KEYS.has(k));
      if (bad.length) return `set_meta 不允许写字段: ${bad.join(', ')}（id 不可改）`;
      return null;
    }
    default:
      return null;
  }
}

/** 应用单个动作到 wf（在 precheck 通过后调用；返回新 wf，不就地修改）。 */
function applyOne(wf, action) {
  const out = clone(wf);
  switch (action.action) {
    case 'add_node': {
      const id = action.id || autoNodeId(out.nodes, action.title, action.type);
      const node = blankNode(id, action.type, action.title, action);
      out.nodes.push(node);
      return { wf: out, nodeId: id };
    }
    case 'remove_node': {
      const id = action.id;
      out.nodes = out.nodes.filter((n) => n.id !== id);
      out.edges = out.edges.filter((e) => e.from !== id && e.to !== id);
      return { wf: out };
    }
    case 'set_node': {
      out.nodes = out.nodes.map((n) => {
        if (n.id !== action.id) return n;
        const patch = action.patch || {};
        const next = { ...n };
        for (const k of Object.keys(patch)) {
          if (k === 'body' && n.body) next.body = { ...n.body, ...clone(patch.body) };
          else next[k] = clone(patch[k]);
        }
        return next;
      });
      return { wf: out };
    }
    case 'add_edge': {
      const e = { from: action.from, to: action.to };
      if (action.when !== undefined) e.when = clone(action.when);
      if (action.default !== undefined) e.default = !!action.default;
      out.edges.push(e);
      return { wf: out };
    }
    case 'remove_edge': {
      out.edges = out.edges.filter((e) => !(e.from === action.from && e.to === action.to));
      return { wf: out };
    }
    case 'set_edge': {
      out.edges = out.edges.map((e) => {
        if (!(e.from === action.from && e.to === action.to)) return e;
        const patch = action.patch || {};
        const next = { ...e };
        for (const k of ['when', 'default']) {
          if (k in patch) next[k] = k === 'default' ? !!patch[k] : clone(patch[k]);
        }
        return next;
      });
      return { wf: out };
    }
    case 'set_routes': {
      out.nodes = out.nodes.map((n) => {
        if (n.id !== action.id) return n;
        const next = { ...n };
        next.routes = clone(action.routes);
        delete next.approveTo;
        delete next.rejectTo;
        return next;
      });
      return { wf: out };
    }
    case 'set_meta': {
      for (const k of Object.keys(action)) {
        if (k === 'action') continue;
        out[k] = clone(action[k]);
      }
      return { wf: out };
    }
    default:
      return { wf: out };
  }
}

/**
 * 把编辑动作序列应用到工作流草稿。
 * @param {object} workflow 现有工作流（不可变：无论成败都不修改入参）
 * @param {Array}  edits    编辑动作数组 [{ action, ... }]
 * @returns {{ workflow, applied: Array, rejected: Array }}
 */
export function applyEdits(workflow, edits) {
  if (!workflow || typeof workflow !== 'object') {
    return { workflow, applied: [], rejected: [{ action: null, reason: 'workflow 必须是对象' }] };
  }
  if (!Array.isArray(edits)) {
    return { workflow: clone(workflow), applied: [], rejected: [{ action: null, reason: 'edits 必须是数组' }] };
  }
  if (!Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) {
    return { workflow: clone(workflow), applied: [], rejected: [{ action: null, reason: 'workflow 必须是 { nodes, edges } 结构' }] };
  }

  let current = clone(workflow);
  const applied = [];
  const rejected = [];

  for (const action of edits) {
    const err = precheck(current, action);
    if (err) {
      rejected.push({ action: clone(action || null), reason: err });
      continue;
    }
    try {
      const { wf, nodeId } = applyOne(current, action);
      current = wf;
      applied.push({ action: action.action, nodeId, from: action.from, to: action.to, id: action.id });
    } catch (error) {
      // 单动作意外错误：按 rejected 处理，不污染图
      rejected.push({ action: clone(action), reason: `应用动作失败: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  // 图结构终检：整批合法性。不通过 → 整批回滚，绝不放行坏图。
  const v = validateWorkflow(current);
  if (!v.ok) {
    const reason = `图校验未通过: ${(v.errors || []).join('；')}`;
    return { workflow: clone(workflow), applied: [], rejected: [...rejected, { action: null, reason }] };
  }

  return { workflow: current, applied, rejected };
}
