/**
 * dsh-knj-workflow 流程配置规范（单一来源）
 * ---------------------------------------------------------------
 * 用途：作为 AI 助手配置流程图时的规范依据（注入 prompt），也是插件内"流程配置规范"的
 * 唯一文字来源——避免规范散落在 prompt 字符串、文档、代码注释三处而互相漂移。
 *
 * 依据（改动任一处后本文件必须同步复核）：
 *   - lib/graph.js  validateWorkflow（硬约束的权威实现：保存时真正会拦下什么）
 *   - docs/workflow-mechanics.md §7 / §7.1（运行机制、已知限制、保存校验规则）
 *   - docs/workflow-guide.md（面向用户的节点/连线/网关/审批配置手册）
 *   - WORKFLOW-DESIGN.md（图编排语义设计）
 *   - DESIGN.md §9 踩坑记录（如 implement 阶段 prompt 要求跑构建导致子 agent 挂起）
 *
 * 一致性保障：lib/assist-rules.test.js 逐条断言"本规范声称的硬约束，validateWorkflow
 * 确实能拦下"——规范写错比不写更危险，故用测试把它与实现绑定。
 *
 * 分节结构：每节 { id, title, lines[] }；ASSIST_RULES 是供 prompt 使用的拼接文本。
 */

export const ASSIST_RULES_SECTIONS = [
  {
    id: 'graph',
    title: '一、图的基本形态（硬约束，保存时会被拦）',
    lines: [
      '必须恰好一个 start 与一个 end；两者都不能被删除。',
      '除 start 外，每个节点都必须有入边（孤立节点 = 不可达 = 报错）。',
      '同一对节点之间只能有一条边（from→to 唯一），否则报「重复边」。',
      '节点 id 唯一；start/end 的 id 固定为 start / end。',
      '任何节点（start/task 除外 end 可无出边）不能断头：task/start 零出边在运行时会失败——流程必须最终走到 end。',
    ],
  },
  {
    id: 'node-types',
    title: '二、节点类型与选型',
    lines: [
      'task：派一个 AI 执行「行为 prompt」并产出结构化结果——绝大多数阶段都用它。',
      'gateway-xor（排他网关）：按条件多选一，必须有 ≥2 条出边且至少 1 条 default。',
      'gateway-and（并行网关）：split（多出单入，并行开展分支）或 join（多入单出，等全部完成）；不能既是 split 又是 join。',
      'human（人工审批）：流程暂停等人点「通过/驳回」等按钮；去向由 routes 定义。',
      '选型经验：能用 task 顺序解决的不要加网关；只有真的需要分支/并行/人工确认才引入。',
    ],
  },
  {
    id: 'task-config',
    title: '三、task 节点配置规范',
    lines: [
      'title：中文可读名（如「需求分析」「代码验证」），用于画布与进度展示。',
      'id：有意义的英文短标识（如 analyze / coding / verify），下游用 ${id.字段} 引用；不要用无意义的随机 id（自动生成的 task-xxxx 应改名）。',
      'body.prompt：写清「本阶段做什么、输入是什么、产出什么」，用 ${...} 显式引用上游输出（模板不自动注入上下文）。',
      'body.mode：single（一个 AI 完成，默认）；parallel（派多个 AI 并行做同一件事，结果合并为数组，适合批量审查）。',
      'body.output：声明本阶段产出字段。关键字段务必配类型：',
      '  · 判断用字段（如 passed）配 boolean，否则网关条件判断不可靠；',
      '  · 列表字段（如 changedFiles/issues）配 array，否则下游拿到的是字符串；',
      '  · 枚举字段（如 level=high/low）写明可选值。',
      'maxRuns：本节点一轮内最多执行几次（默认 3）。位于驳回/回环上的节点应显式设置，避免意外超限失败。',
      'prehook/posthook：可选，执行前后做额外动作（git pull、mkdir、写文件等），通常不需要配。',
      'prompt 不要要求子 agent 执行构建/编译/跑测试等重命令——子 agent 在受限环境里容易挂起导致任务卡死；要验证就让节点产出结论字段。',
    ],
  },
  {
    id: 'edges',
    title: '四、边与条件',
    lines: [
      '普通流转边：{ from, to }，单出边节点不需要条件。',
      '条件边：when: { field, op, value }；op 取 eq（等于）/ neq（不等于）/ in（包含于数组）。',
      'field 三种写法：裸字段名（相对作用域：XOR 取唯一上游输出，task 多出边取自身输出）、${节点id.字段}（显式引用任意已执行节点，取原始值）、裸点号路径（verify.passed，同上）。',
      'value 会按字面识别布尔/数字（true、5）；也可引用任务变量（如 ${inputs.level}）。',
      'default 边：兜底边，所有条件都不命中时走它；default 也可以同时带条件（参与匹配，命中优先）。',
      '多出边（XOR 网关或 task）时，除 default 外每条边都必须配 when，否则是「永不命中」的死边 → 保存报错。',
      '多条条件边按声明顺序「最先命中」生效。',
      '回环（驳回重做）不需要特殊标记：任何 from→更早节点 的边就是回边，由节点 maxRuns 防死循环。',
    ],
  },
  {
    id: 'xor',
    title: '五、XOR 排他网关',
    lines: [
      '至少 2 条出边，且必须有一条 default（否则条件都不命中时流程中断）。',
      '条件字段通常来自唯一上游节点的输出（如上游输出 level，则当条件写 field: level）。',
      '典型用法：按复杂度分流——level eq high → 走设计；default → 直接编码。',
      '若某分支只是「跳过某阶段」，可以用一条 default 直接连到后面的节点，不必为跳过的节点连空边。',
    ],
  },
  {
    id: 'and',
    title: '六、AND 并行网关',
    lines: [
      'split：多出边、单入边；join：多入边、单出边；两者不能混在一个节点上。',
      'split 与 join 成对出现：split 拉出的每条分支都要汇到同一个 join，再由 join 继续往下。',
      '不支持嵌套并行：split 分支里再放 split 会导致 join 配对错乱、共享节点被重复执行——请用「扁平」的一层并行。',
      '并行分支内不能放 human 节点（保存会被拦）：人工审批请放在 join 之后或串行链路上。',
      '某分支失败 → 整个并行节点失败（严格语义），不要把可选步骤塞进并行分支。',
    ],
  },
  {
    id: 'human',
    title: '七、人工审批（human）',
    lines: [
      'routes：至少一条去向，每条 = { label（按钮文字，如「通过」「驳回」「小改」）, to（目标节点）, tone?: success|danger|warning|info }；label 不能重复，to 必须存在。',
      'displayFrom：审批时展示哪个上游节点的产物（如 verify），让人先看结果再决定。',
      '审批意见：审批人可填写意见，会注入去向目标节点（驳回重做的 AI 能看到）。',
      '驳回回环：驳回 → 回到某个上游节点（如 coding），该回环上的节点要设 maxRuns，避免无限重做。',
      '多去向 = 审批界面多个按钮；不要用多个 human 节点表达同一处审批。',
    ],
  },
  {
    id: 'dataflow',
    title: '八、数据流与引用语法',
    lines: [
      '${inputDescription}：新建任务时录入的需求描述；${inputTitle}：任务标题；${storyCode}：用户故事编码（可选）。',
      '${cwd}：任务工作目录；${taskId}：本任务实例 id（同一任务续跑/重跑不变，可用于产物路径隔离）。',
      '${inputs.参数名}：任务输入参数；${节点id.字段}：上游节点输出的字段；${节点id}：该节点全部输出（JSON）。',
      '没有「字段映射」配置：直接引用 ${节点id.字段} 即可，重名字段不会冲突。',
      '被跳过的分支（XOR 未选中、断点跳过）其引用解析为空字符串——下游 prompt 要能容忍空值。',
    ],
  },
  {
    id: 'artifacts',
    title: '九、产出与落盘',
    lines: [
      '任务指定工作目录时，每个 task 节点运行时会自动声明该目录，子 agent 的文件/命令操作都在其中。',
      '产物按实例隔离用 ${taskId} 拼路径（如 ${cwd}/out/${taskId}/），避免同一工作区并发任务互相覆盖。',
      '目录不会自动创建：需要落盘时在 prompt 里明确要求先建目录，或用 mkdir 前置动作。',
      '每个节点完成后结果会自动落盘为断点（stages/<节点id>.json），供取消/失败后「续跑」跳过已完成节点。',
    ],
  },
  {
    id: 'runtime',
    title: '十、运行语义与限制',
    lines: [
      '失败即停：任何节点失败（子 agent 无有效输出、并行分支失败、循环超限）整个任务失败，不会静默跳过。',
      '循环保护：节点执行次数超过 maxRuns（默认 3）即失败——这是防死循环的唯一机制。',
      '续跑/重跑：任务失败或取消后可「续跑」（跳过已完成节点）或「重跑」；人工审批过的节点在续跑时按最后决策重放，不重复暂停。',
      '取消不保留中间结果；进程重启会丢失进行中的 run（断点产物仍在，可续跑）。',
      '子 agent 挂起没有超时保护——所以 prompt 不要要求长耗时命令（见第三节）。',
    ],
  },
  {
    id: 'antipatterns',
    title: '十一、反模式（不要这样做）',
    lines: [
      '不要留孤立节点或断头链（task 没有出边）。',
      '不要让 task/XOR 的多条出边里出现没有条件的非 default 边（永不命中）。',
      '不要把 human 放进并行分支内；不要嵌套并行。',
      '不要在 prompt 里让子 agent 跑构建/编译/长测试。',
      '不要用无意义 id（task-a1b2c3 之类），也不要在改名后忘记同步 prompt 里的 ${旧id.字段} 引用。',
      '不要让所有节点都 parallel——只有确实需要并行分片时才用。',
      '不要为「可选步骤」在流程里制造无法收敛的环（每个环都要有 maxRuns 与明确的退出条件）。',
    ],
  },
  {
    id: 'patterns',
    title: '十二、推荐模式（可直接参考）',
    lines: [
      '线性流水线：start → 需求分析 → 实现 → 代码验证 → end。',
      '条件分流：需求分析（输出 level）→ XOR（level eq high → 设计 → 编码；default → 编码）→ 验证 → end。',
      '带审批与驳回：验证（输出 passed）→ XOR（passed eq true → 人工评审；default → 修复 → 回到验证）→ 人工评审（通过 → end；驳回 → 回编码）→ end。',
      '并行审查：编码 → AND split → 三个审查 task → AND join → 汇总 → end（审批放在 join 之后）。',
    ],
  },
];

/** 供 prompt 使用的规范文本（分节标题 + 条款）。 */
export const ASSIST_RULES = ASSIST_RULES_SECTIONS
  .map((s) => `${s.title}\n${s.lines.map((l) => (l.startsWith('  ') ? l : `- ${l}`)).join('\n')}`)
  .join('\n\n');
