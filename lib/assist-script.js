/**
 * dsh-knj-workflow AI 助手编排脚本（workflow 工具执行体，薄壳）
 * ---------------------------------------------------------------
 * 输入 args：
 *   prompt - 已由 Host 端组装好的完整系统提示（角色 + 图摘要 + 规则卡 + 历史 + 用户指令）。
 *
 * 行为：把 args.prompt 派给一个 subagent，要求返回 { reply, edits }：
 *   - reply：对用户说的自然语言回复
 *   - edits：对流程图的修改动作数组（结构与 lib/assist-edits.js 校验一致）
 *
 * 输出：
 *   { reply, edits } —— Host 端收到后交给 assist-edits.applyEdits 做校验与应用。
 *
 * 注意：本脚本运行在 workflow 引擎沙箱（无 fs/network/require），prompt 由 Host 组装、
 * edits 合法性由 Host 的 applyEdits 兜底，这里只做转发与基础容错。
 */

const promptText = String(args.prompt || '').trim();
if (!promptText) {
  throw new Error('args.prompt 不能为空');
}

// 过程台词：以 workflow/log 事件回传 Host，前端在对话坞里实时显示（让用户看到"助手在做什么"）
try { log('已读取当前流程图，正在分析你的指令…'); } catch {}

// 输出 schema：宽松限定顶层形状（edits 各项结构由 Host 端 applyEdits 终检，不在此穷举）
const outSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    edits: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
  },
  required: ['reply'],
  additionalProperties: true,
};

const output = await agent(promptText, { label: '工作流设计助手', schema: outSchema });
if (output === null || output === undefined) {
  // 与 orchestrator 教义一致：subagent 无有效输出 → 显式失败，不得静默成功
  throw new Error('设计助手无有效输出（schema 校验失败或 subagent 失败）');
}

const edits = Array.isArray(output.edits) ? output.edits : [];
try { log(`设计助手已给出 ${edits.length} 项改动，正在校验…`); } catch {}

return {
  reply: typeof output.reply === 'string' ? output.reply : '',
  edits,
};
