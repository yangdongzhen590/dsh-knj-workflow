/**
 * dsh-knj-workflow AI 助手 prompt 组装（纯函数，零依赖）
 * ---------------------------------------------------------------
 * summarizeWorkflow(workflow)  —— 把工作流图压缩成结构文本（token 只给引用所需：
 *                               节点 id/type/title、边 from→to + when/default、human routes；
 *                               不含 x/y 坐标、不含长 prompt 全文——行为细节由画布承载）。
 * buildAssistPrompt({ summary, history, message, ruleCard }) —— 组装完整系统提示：
 *                               角色定位 + 图摘要 + 编辑动作规则卡 + 最近对话历史 + 本轮消息。
 * ASSIST_RULE_CARD                —— 编辑动作规则卡（AI 生成 edits 的动作语法说明）。
 *
 * 仅供 Host 端组装 args.prompt 使用；assist-script.js 只负责把它派给 subagent。
 */

import { ASSIST_RULES } from './assist-rules.js';

/** human 节点去向（routes 优先，兼容旧 approveTo/rejectTo）。 */
function humanRoutes(node) {
  if (Array.isArray(node.routes) && node.routes.length > 0) return node.routes;
  const r = [];
  if (node.approveTo) r.push({ label: '通过', to: node.approveTo });
  if (node.rejectTo) r.push({ label: '驳回', to: node.rejectTo });
  return r;
}

/** 输出字段的紧凑描述：level(string)、passed(boolean)、changedFiles(array)。 */
function describeOutput(node) {
  const out = node && node.body && node.body.output;
  if (!out || typeof out !== 'object' || !out.properties) return '';
  const parts = Object.entries(out.properties).map(([k, v]) => {
    const t = (v && v.type) || 'auto';
    const extra = v && v.description ? `（${v.description}）` : '';
    return `${k}:${t}${extra}`;
  });
  return parts.length ? `，输出 { ${parts.join('，')} }` : '';
}

/**
 * 图 → 结构摘要文本。缺 nodes/edges 不抛错（可读空摘要）。
 * @param {object} workflow
 * @returns {string}
 */
export function summarizeWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object') {
    return '（当前没有可用的工作流图）';
  }
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  const lines = [];
  const wfName = workflow.name || '(未命名)';
  lines.push(`工作流：${wfName}${workflow.id && workflow.id !== wfName ? `（id: ${workflow.id}）` : ''}${workflow.description ? `（${workflow.description}）` : ''}`);

  lines.push('节点：');
  if (nodes.length === 0) lines.push('  （空）');
  for (const n of nodes) {
    const typeNames = {
      start: '开始', end: '结束', task: '任务', 'gateway-xor': '排他网关', 'gateway-and': '并行网关', human: '人工审批',
    };
    let line = `  [${n.id}] ${typeNames[n.type] || n.type}「${n.title || ''}」（${n.type}）`;
    if (n.type === 'task') {
      const mode = n.body?.mode === 'parallel' ? '并行' : '';
      line += ` ${mode}${describeOutput(n)}`.trimEnd();
    }
    if (n.type === 'human') {
      const routes = humanRoutes(n);
      line += routes.length
        ? `，去向：${routes.map((r) => `「${r.label}」→ ${r.to}`).join('；')}`
        : '，去向未配置（非法）';
    }
    lines.push(line);
  }

  lines.push('连线：');
  if (edges.length === 0) lines.push('  （空）');
  for (const e of edges) {
    let line = `  ${e.from} → ${e.to}`;
    if (e.when && e.when.field) {
      const opText = { eq: '==', neq: '!=', in: 'in' }[e.when.op] || e.when.op;
      line += ` [when: ${e.when.field} ${opText} ${Array.isArray(e.when.value) ? e.when.value.join('/') : e.when.value}]`;
    }
    if (e.default) line += ' [default]';
    lines.push(line);
  }

  return lines.join('\n');
}

/** 编辑动作规则卡：AI 用动作序列表达修改意图，动作结构与 Host 端校验一致。 */
export const ASSIST_RULE_CARD = `【你如何修改流程】
你的回复必须同时包含 reply（对用户说的话，自然语言）和 edits（对流程图的修改动作数组）。
edits 支持的动作：
- add_node       新增节点：{ action:'add_node', type:'task'|'gateway-xor'|'gateway-and'|'human', title:'显示名', id?:'编码', body?:{ prompt, mode:'single'|'parallel', output? } }
                  说明：task 用 body.prompt 写行为；human 可带 routes:[{label:'通过',to:'xxx'}]；
                  无 id 时按标题生成（task-<slug>，如 title:'Verify' → id:'task-verify'，后续连线请用该 id）。
- set_node       改节点属性：{ action:'set_node', id, patch:{ title?|body?|routes?|maxRuns? } }（不可写 x/y/id/type）
- remove_node    删除节点：{ action:'remove_node', id }（不可删 start/end）
- add_edge       连线：{ action:'add_edge', from, to, when?:{field,op:'eq'|'neq'|'in',value}, default?:true }
- remove_edge    删线：{ action:'remove_edge', from, to }
- set_edge       改边：{ action:'set_edge', from, to, patch:{ when?|default? } }
- set_routes     配 human 去向：{ action:'set_routes', id, routes:[{label,to}] }
- set_meta       改元信息：{ action:'set_meta', name?|description?|inputs? }（不可改 id）

规则：
1. 逐条小步修改；要插入新分支时，先 remove_edge 拆开原边再接新边，避免节点多出边未配条件。
2. task 节点若有多条出边，除 default 外每条都必须配 when（否则该边永不命中，非法）。
3. XOR 网关至少 2 条出边且含 1 条 default；引用不存在的节点/边、删 start/end 都会整批被拒。
4. 不需要也不允许写 x/y 坐标（布局由编辑器负责）；不要整体重发整张图。
5. 不确定的字段宁可不写，也不要编造节点 id——id 必须来自「当前图」摘要里的节点。`;

/**
 * 组装完整系统提示。
 * @param {object} opts { summary, history?, message, ruleCard? }
 * @returns {string}
 */
export function buildAssistPrompt({ summary, history, message, ruleCard } = {}) {
  const parts = [];
  parts.push(`你是 dsh-knj-workflow 的工作流图设计助手。你在帮助用户在流程编辑器里通过对话配置/修改一张工作流图。当前工作区上方显示的就是这张图；你的每次回复都会把修改动作实时应用到画布。`);
  parts.push(`【当前图状态】\n${summary || '（当前没有可用的工作流图摘要）'}`);
  parts.push(`【本插件的流程配置规范（必须遵守）】\n${ASSIST_RULES}`);
  parts.push(ruleCard || ASSIST_RULE_CARD);
  const h = Array.isArray(history) ? history : [];
  if (h.length) {
    const histText = h.map((m) => {
      const role = m.role === 'user' ? '用户' : '助手';
      return `${role}：${m.content || ''}`;
    }).join('\n');
    parts.push(`【最近对话】\n${histText}`);
  }
  parts.push(`【用户本轮指令】\n${message || ''}`);
  return parts.join('\n\n');
}
