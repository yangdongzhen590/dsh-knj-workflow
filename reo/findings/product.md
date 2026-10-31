# 产品视角：dsh-knj-workflow 是什么、给谁用、真实用成了什么样

> 产出人：product-runtime（Team Lead 的产品侧分析专员）
> 版本基准：工作区 `D:\dsh-knj\dsh-knj-workflow` @ v2026.10.218
> 采集方式：只读。所有数字均由 `reo/tmp/*.mjs` 一次性脚本解析原始文件得出（避免中文乱码），脚本可复跑。
> 标注约定：**[事实·强]** = 直接读取原始数据/源码/截图可见；**[事实·中]** = 计数受样本或日志混杂影响；**[推断]** = 由多处证据交叉推出，未直接证实；**[未知]** = 本机无法验证（如 npm 线上状态）。

---

## 0. 一句话结论

**这是一个"把研发流程画成图、让每个节点跑一个 subagent、由人工在关键节点拍板"的 DSH 插件**——它把"工作流引擎"包装成普通用户能用的产品：左边栏点「新建任务」填一段需求，任务就按预配置的流程图自动跑，右侧一行步骤条实时显示跑到第几阶段，卡在审批点等人点「通过/驳回」，失败可单阶段重跑。它已经**真实跑过 24 个任务、51 个 subagent 会话、8 个自建工作流**，但真实用途目前仍以 **插件自身的自测/造数为主**（详见 §6）。

---

## 1. 产品定位 / 目标用户 / JTBD

### 定位（一句话）
**面向"自己就是使用者"的开发者的可视化 AI 研发流水线**：不用写脚本，用一张图定义"需求分析→复杂度判断→设计/编码→验证→人工评审"这类可复用的 AI 工作流，然后以任务为单位批量、可暂停、可回溯地跑。

### 目标用户（从证据反推，不靠猜）
| 用户画像 | 证据 |
|---|---|
| **单人开发者 / 独立开发者**（本机唯一使用者 `MrYang`，Windows，cwd `D:\workspace\iobs_pro`、`D:\dsh-knj\*`）**[事实·强]** | 24 个任务里 12 个在 `D:\workspace\iobs_pro`、5 个在本插件仓库自己身上（`D:\dsh-knj\dsh-knj-workflow`）、4 个在 `dsh-knj-prompts` **[事实·强]** |
| **已经重度使用 DSH 的人**（宿主 DSH 0.2.1-rc.2，profile 装了 30+ 插件、28 个 bundle）**[事实·强]** | `C:\Users\MrYang\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` 28 项 |
| **写提示词/搭流程这类"元工作"从业者**，愿意为流程本身迭代 17 个版本 **[事实·强]** | `wf-dev-flow` 的 `revision: 17`（其余工作流 rev 2–5） |

### 核心 JTBD
1. **"把一件需要多轮 AI 协作的活儿，变成点一次按钮就能按套路跑完"** —— 省掉每次手打 5 段提示词、手动搬运上一轮产物。
2. **"跑到关键节点停下来让我把关"** —— 人工节点 + 通过/驳回按钮 + 意见注入下游（`decisions` 字段实存 13 条记录）。
3. **"跑失败了别从头再来"** —— 阶段断点落盘 + 单阶段重跑 + 继续。
4. **"同一套流程我要反复用、还要能改"** —— 模板导入导出 + 图编辑器 + 用自然语言让 AI 改图。

---

## 2. 界面真身：三张截图实读（不是猜测）

三张图都在 `assets/screenshots/`，均已用 `read_image` 逐张看过（1280×800）。**重要前提：这三张图是 2026-08-28 提交的老版本 UI**（`git log`：`1b32883`/`f408036`/`247010e`，均 `2026-08-28 01:09`），与当前代码存在 3 处可见漂移（§7.2）。但它们仍是唯一"产品外形"证据。

### 2.1 `new-task-modal.png` — 新建任务弹窗
真实存在的控件（自上而下）：
- 标题栏「新建开发任务」+ 右上「关闭」。
- **需求描述（必填）** multitextarea，placeholder＝「描述你要做什么，如：用户可从文件列表勾选多个文件并批量下载」。
- **标题（创建后自动总结，可改）** 单行输入，placeholder「留空则创建后自动总结」。
- **用户故事编码（可选）ⓘ**，placeholder「如 US-123（可留空）」。
- **工作流** 下拉，选中项显示「开发流程验证（6 阶段）」——**"N 阶段"= 图中 `type==='task'` 节点数**（`lib/client.js:2849`）。
- **工作目录（可选）** 下拉（截图值 `MrYang`）。
- **执行模型（可选，留空继承当前会话）ⓘ** 下拉（截图值「继承当前会话（默认）」）。
- 底部「取消」/「创建并启动」。
- 左侧栏：顶部「＋ 新会话」；下方「＋ 新建任务」；「更多」折叠组里可见 **`开发任务`、`调度器`** 两个入口；会话列表里有一条异常标题「工作流创建失败：无活跃Ag…」（推断是某次建流程失败被当作会话主题，与该日日志里 235 次「无法确定任务工作目录：当前没有活跃会话可继承」同类失败吻合）。

**交互暗示**：表单全部平铺、无分步；工作流与工作目录都是预设下拉（说明产品假设你是单机单用户，目录是有限的几个工作区）；"必填/可选"标注已细化到每个字段；执行模型是显式可选（说明额度不足时会换模型跑）。

### 2.2 `task-detail.png` — 任务详情
- 全屏面板，标题「开发任务」+ 右上「关闭」；两个 tab：**任务（激活）/ 工作流**。
- 任务头：圆形图标占位「—」、标题 `parent-leak-test`、任务 id `task-mtbqdofq`；右侧「↻ 刷新」按钮 + 绿色状态胶囊「成功」。
- **蓝色满格进度条**，文案「进度 100% · 完成 1/1 阶段」。
- 「流程进度 (1)」分组，内有一个阶段卡片：绿色 ✓、阶段名 `task`、副信息「1m0s · 完成」（**时长 + 状态**是阶段卡片的两条关键信息）。
- 整个面板压住了底层页面（左侧可见暗色遮罩），说明**详情不是右栏抽屉，而是主区接管式覆盖面板**。

### 2.3 `workflow-editor.png` — 工作流图编辑器
- 顶部 tab 同上（工作流激活）；工具条一行：`← 返回` | 工作流名称输入「开发流程验证」 | 工作流 ID 输入 `wf-dev-flow` | 🔒 锁定 | `−` `100%` `+`（缩放） | `⛶ 全屏` | `自动布局` | `↶` `↷`（撤销/重做） | `⚠ 配置说明` | `保存`（深色主按钮）。
- 左侧「添加节点」面板 4 个按钮：**任务节点 / 排他网关 / 并行网关 / 人工节点**；下方「说明」小字：「拖节点移动；从节点右侧圆点拖到目标节点连线；点节点编辑配置；点边编辑条件。」——**交互模型（拖拽 + 端口连线 + 点选编辑）在 UI 文案里被明示**。
- 画布：网格背景；已画出 `开始 → 需求分析 → 复杂度分析`，连线为**红色虚线 + 箭头 + 蓝色连接点**。
- 右侧属性检查器（空态）：「点击节点编辑配置，点击连线可删除」——**空态即教学**，这一栏宽度约占 1/4。

**截图与真实工作流的对应关系 [事实·强]**：截图里 `开始(x=120,y=128)`、`需求分析(x=320,y=176)`、`复杂度分析(x=520,y=176)` 三个节点的相对坐标与 `workflows.json` 里 `wf-dev-flow` 的节点坐标**逐像素对应**（dx=200、dy=48）；名称 `开发流程验证`、ID `wf-dev-flow` 完全一致。→ 这张图拍的就是本机这套真实工作流，不是合成图。

**截图的时代痕迹 [事实·强]**：截图里的任务 `task-mtbqdofq` 不在当前 24 个任务目录中，只在 `knj-host-debug.log` 出现 1 次（`2026-09-02T16:51 cancelTask`）→ 截图是插件自测/演示期间抓的，任务后来被删了。

---

## 3. 功能地图（按用户旅程 · 用户可见行为 ↔ 实现载体）

> 载体列中 `client` = 前端 UI（`lib/client.js` 单文件 289KB/4293 行），`index` = Host 端（`lib/index.js` 119KB/2338 行），`orch` = 编排脚本（`lib/orchestrator.js`），`graph` = 图模型/校验（`lib/graph.js`）。

| # | 旅程 | 用户可见行为 | 实现载体（代码/路由/落盘） |
|---|---|---|---|
| 1 | **配置流程** | 左栏入口打开流程设计 → 工作流列表 → 新建/编辑；画布拖节点、拉连线、点节点改配置；`自动布局`、撤销/重做、缩放、全屏；`配置说明` 内置手册 | `client` 图编辑器类（~L1000–2300，含 `undo/redo` 栈 L1020、`自动布局` L963、配置说明 L1626/1666）；`graph`：`NODE_TYPES = {start,end,task,gateway-xor,gateway-and,human}`（L16）、`validateWorkflow`；路由 `GET/POST/PUT /devtask/workflows`、`DELETE /devtask/workflows/:id`；落盘 `workflows.json` |
| 2 | **建任务** | 填需求（可空）→ 标题自动派生 → 选工作流/工作目录/执行模型/用户故事编码 → 可加「附件」或文件类型入参 → 「创建并启动」 | `client` 弹窗（L2503–2927，`需求描述（可选）` L2742、标题派生注释 L2896）；`index` `POST /devtask/tasks`（L1755）；`lib/requirement.js`：`INLINE_MAX=8000`、`HEAD_MAX=6000`、标题取首行 50 码点；附件 `lib/attachments.js`（`MAX_ATTACHMENTS=20`）；文件入参 `lib/uploads.js`（`MAX_UPLOAD_BYTES=32MB`、`STAGING_TTL_MS=24h`）、`POST /devtask/uploads` |
| 3 | **跑任务** | 点「创建并启动」后任务自己往下跑；无需留在页面 | `index` `WorkflowBridge.startTask` → `resolveWorkflowEngine`（L553–572，`presets.serviceFor` → 回落 `scope.ctx.get`）→ `ctx.workflowEngine` 启 `lib/orchestrator.js`；`orch`：逐节点执行 subagent（L275）、`gateway-xor` 按 `when` 路由（L129）、`human` 停住返回 null（L125）、`maxRuns` 默认 3 防死循环（L46–56）；每阶段落盘 `tasks/<id>/stages/<stageId>.json` |
| 4 | **看进度** | 5 列看板（待执行/运行中/待人工处理/成功/失败·已取消）+ 表格两形态；任务卡片显示进度 %；任务详情横向步骤条 + 每阶段时长；`刷新` | `client` `BOARD_COLUMNS`（L2930–2936）+ 看板样式 L624+/主区接管 L507、详情步骤条 L4097–4150；路由 `GET /devtask/tasks`（`?archived=1`、`?q=` 由 Host 全文过滤，L1734–1741）、`GET /devtask/tasks/:id` |
| 5 | **人工审批 / 重跑 / 继续 / 取消 / 归档** | 跑到人工节点暂停，卡片进「待人工处理」列；点「通过/驳回」并填意见；失败阶段点「重跑」；暂停/失败点「继续」；可取消、可归档/恢复 | 人工节点去向 = 每工作流自定义按钮（`client` L2263「去向（审批按钮，可多条）」），旧 `通过/驳回` 自动兼容；路由 `POST /tasks/:id/decide`（L2030，`approve→通过`/`reject→驳回` 映射 L2046–2048）、`/rerun-stage`（L1886）、`/resume`（L1943）、`/cancel`（L1877）、`/archive`、`/restore`、`DELETE /tasks/:id`；决策落 `task.decisions[]`，人工产物落 `task.humanState.results` |
| 6 | **定时调度** | 在 dsh-scheduler 里新建「KNJ 工作流」类型任务：选工作流、填入参（可用「路径引用」指向文件）、按 Cron 触发；历史可直接跳回任务详情 | 插件侧 `createKnjWorkflowSchedulerService`（`index` L407）+ `ctx.provide('knjWorkflowScheduler', …)`（L2327）；调度器侧 `dsh-scheduler/lib/executor.js:39-53`、`routes.js:90-92`、`types.js:12/60-83`、`attachments.js:92`（详见 §8） |
| 7 | **AI 改流程** | 编辑器下半区对话坞（左=对话过程 / 右=指令输入），用自然语言说"在 coding 后加代码验证节点，通过走人工评审、失败回 coding"；AI 返回"回复 + 编辑动作序列"，逐条校验后应用到画布；整轮改动=一次撤销；可看推理/工具/正文流与 token 用量 | `client` 对话坞（L1279–1320 轮询、L1516+ 过程行）+ 任务卡；路由 `POST /devtask/assist`（202 异步，L1677）、`GET /devtask/assist/progress`（L1692）；`lib/assist-prompt.js`（系统提示 + 流程规范）、`lib/assist-rules.js`（语义预检）、`lib/assist-edits.js`（add_node/set_node/remove_edge/add_edge/set_routes 应用）、`lib/assist-script.js` |
| 8 | **其他斜杠/周边** | `/dev-task new <标题> / list / status <id> / wf`；模板 `.workflow.json` 导入导出（同 ID 冲突提示）；助手完整会话跳转；产物文件预览 | `index` 命令注册 L2234–2302；`client` 导入解析 L184–198、导出 L157–180、列表导出按钮 L943、导入进编辑器 L909；会话跳转 `client` L20–80（`uiWorkspace.openSession`）+ `lib/session-jump.test.js`；预览 `GET /tasks/:id/file`，优先借 `betterSidebar`（L3876）否则内嵌 |

**四个不显眼但很"产品化"的设计（事实）**：
- `GET /devtask/models`（L1605）**不依赖 llm 服务**，而是直接解析 `~/.dsh/settings.yaml` 里真实配置的 provider/model——注释写明是为了"避免内置猜测出无效 provider id 导致 subagent 启动失败"。这是踩过坑的痕迹。
- `GET /devtask/diag`（L1648）是**给用户/开发者排障用的诊断端点**，专门暴露 `workflowEngine` 在各层 scope 的可见性。
- 标题不是输入框，而是 `deriveTaskTitle`（首行去 `#`→50 码点；空则 `未命名任务 MM-DD HH:mm`）。
- 内置附件在 Host 侧**启动前**物化到 `<cwd>/.knj-inputs/<taskId>/` 并写 `.gitignore`（内容 `*`），把"用户上传的文件"和"用户版本库"隔离。

---

## 4. 真实使用证据（数字表）

数据根：`C:\Users\MrYang\.dsh\dev-orchestrator`（默认 `dataRoot`，profile 未覆盖）。

### 4.1 工作流（`workflows.json`，41,723 字节 / 35,001 字符，顶层 `{workflows:[…]}`）

**8 个工作流，全部 `schemaVersion: 2`** **[事实·强]**：

| id | 名称 | rev | 节点 | 类型分布 | 说明 |
|---|---|---|---|---|---|
| `wf-dev-flow` | 开发流程验证 | **17** | 11 | start1/task6/xor2/human1/end1 | 旗舰流程；6 阶段；`复杂度判断` XOR→design(high)/coding(low)；`验证判断` XOR→review(passed)/fix(!passed)；`fix→verify` 回流；人工节点 `代码评审` 去向 通过→end / 驳回→fix，`displayFrom: verify` |
| `wf-dev-flow1` | 开发流程验证 | 2 | 11 | 同上 | **与上一条完全同构（模板导入/复制的产物）** |
| `wf-mtvj2hcs` | 研发工作流 | 2 | 7 | start1/task4/xor1/end1 | 唯一"真写提示词"的流程（prompt 491–842 字符） |
| `wf-mtk3uebw` | 人工节点测试 | 2 | 6 | start1/task3/human1/end1 | 人工审批主力试验场（被 10 个任务使用，最多） |
| `wf-gate` | 测试网关 | 2 | 7 | start1/task4/xor1/end1 | 网关试验 |
| `ts` | ts | 5 | 6 | start1/task3/human1/end1 | 短名流程，用于 `submit`/`fix` 循环试验 |
| `wf-skill-verify` | skill可见性验收 | 2 | 3 | start1/task1/end1 | 「skill」字段的验收（实际 prompt 里没用 skill） |
| `wf-mtbo3i3y` | 测试调用skill | 2 | 3 | start1/task1/end1 | 同上 |

汇总（8 个工作流共 54 个节点）**[事实·强]**：`task 28`、`start 8`、`end 8`、`gateway-xor 6`、`human 4`、**`gateway-and 0`**。
→ **并行网关虽在画布调色板里，但真实数据里一个都没有**；`skill` 字段 28 个任务节点里 **0 个使用**；`body.mode` 全部为 `single`；`inputs`（声明式入参）**8 个工作流全部为空数组**。

### 4.2 任务（`tasks/` 下 24 个目录）

- **24 个任务目录，其中 23 个有 `task.json`，1 个是空目录**（`task-mu90ptev-d36f1926`，0 文件——创建后未写盘/被清理的残留）**[事实·强]**
- `task.json` 字段全集（22 个键）：`id, title, description, workflowId, workflowRevision, workflowSnapshot, status, currentStage, stageStates, humanState, decisions, inputs, model, provider, storyCode, cwd, parentSessionId, createdAt, startedAt, finishedAt, archivedAt, error` **[事实·强]**
- **状态分布**（`status` 枚举全集 = `pending | running | waiting-human | success | failed | cancelled`；真实数据 5/6，`pending` 未在盘上观察到）：

| status | 数量 | 占比 |
|---|---|---|
| success | 11 | 47.8% |
| failed | 6 | 26.1% |
| waiting-human | 4 | 17.4% |
| running | 1 | 4.3% |
| cancelled | 1 | 4.3% |
| **合计** | **23** | 100%（另 1 个空目录） |

- **阶段实例状态分布**（`stageStates[].status`）：`done 39 / skipped 18 / pending 13`，共 70 个阶段实例；其中**真正执行过的阶段 39 个，共拉起 51 个 subagent 会话**（`sessionIds` 计数）**[事实·强]**
- **重跑证据**：`ts` 流程的 `submit` 阶段出现 `sessionIds` ×4、`fix` ×3（`task-mttz5ok7`）→ 单阶段被重复执行 3–4 次，**阶段重跑在真实使用中确实被用过** **[事实·强]**
- **工作流使用分布**：`wf-mtk3uebw 10`、`ts 5`、`wf-gate 4`、`wf-mtbo3i3y 3`、`wf-dev-flow 1`；**8 个工作流里 3 个从未被任务使用过**（`wf-dev-flow1`、`wf-skill-verify`、`wf-mtvj2hcs`）**[事实·强]**
- **需求描述长度**（真实）：max **5 字符**、中位数 **2 字符**、`description` 为空的 **4 个**；**`requirement.md` 落盘 0 个** → README 主打的"十万字长需求 / 8000 字落盘"在真实数据里**完全没有被触发** **[事实·强]**
- **标题派生真实表现**：`title === description` 17 个；`未命名任务 MM-DD HH:mm` 时间戳占位 **4 个**（描述为空）；例外 2 个（`title=测试 / description=单独`，应是早期带显式标题的入口创建）→ **"不填需求也能建任务"当前行为已被真实数据证实** **[事实·强]**
- **工作目录分布**：`D:\workspace\iobs_pro` 12、`D:\dsh-knj\dsh-knj-workflow` 5、`D:\dsh-knj\dsh-knj-prompts` 4、`D:\workspace\tap-taste` 1、无 cwd 1 **[事实·强]**
- **人工决策**：10 个任务有 `decisions`，共 **13 条**，标签分布 **`通过 5 / 驳回 6 / 不通过 2`**；`humanState.results` 出现在 4 个任务里，值有两种形态：字符串（AI 产出正文摘要）与 `{filePath}`（文件产物，如 `D:\workspace\iobs_pro\test.md`）**[事实·强]**
  - 标签不统一是**工作流级配置**造成的（人工节点"去向"按钮文字可自定义），代码里另做 `approve→通过 / reject→驳回` 兼容（`index.js:2046-2048`）→ 跨工作流统计审批结果需要归一化 **[事实·中]**
- **失败原因（`task.error`，逐条）** **[事实·强]**：
  - `节点「task-1」执行失败（subagent 无有效输出）` ×2（`task-mtpzqi21-a7cdc658`、`task-mtwogf4u-2118449b`）
  - `节点「submit」执行失败（subagent 无有效输出）` ×1（`task-mttp8q71`）
  - `节点「fix」本轮执行 4 次，超过上限 3（疑似死循环，请检查连线）` ×1（`task-mttz5ok7`，status=cancelled）
  - `启动失败：workflowEngine unavailable in the owning agent scope (is an agent preset with workflow support mounted?)` ×2（`task-mvl79f2f`、`task-mvl79hqa`，两个 `未命名任务 10-24 00:44`）
- **时长**：17 个任务有起止时间；**中位 354s（≈6 分钟）**，最长 281,047s（含人工等待跨天）；单阶段耗时 17s–1,414s **[事实·中]**（含人工等待，非纯算力时间）
- **归档**：`archivedAt` 存在但 **0 个任务被归档** → 归档/恢复功能未被真实使用 **[事实·强]**
- **文件入参/附件**：`task.inputs` 仅 1 个任务有值 `{附件: "D:\\dsh-knj\\dsh-knj-prompts\\.knj-inputs\\task-mu8ne9xo\\地址.txt"}`；该文件真实存在（379 字节）；`uploads/` 有 8 个暂存目录（含一个 **3.8MB `作业.txt`**，以及 `调度附件A.txt`/`调度附件B.txt` → 调度器+附件联动被测过）**[事实·强]**

### 4.3 调试日志（`knj-host-debug.log`，3,060,410 字节 / 24,557 行 / JSONL）

- 覆盖 **2026-09-02T15:04Z → 2026-10-24T14:21Z**，**16 个活跃日**（09-02…09-20、09-27、10-23、10-24），**26 种事件类型** **[事实·强]**
- **⚠ 关键的诚实修正：这份 3MB 日志不是"24 个真实任务"的日志。** 按 `taskId` 是否命中盘上 24 个任务目录切分：**只有 1,305 行（5.3%）指向真实任务（21 个）**，其余 **23,256 行来自测试夹具任务 id**（481 个，如 `task-x`/`task-w`/`task-8000`/`task-verify-probe-083158`/`task-mt61xq0n`…）**[事实·强]**。→ 引用日志错误频次时必须区分来源，否则会把单测/夹具刷屏当成用户痛点（下表已分列）。
- 全量 Top 事件（说明产品内部状态机粒度很细）：`startTask: 占位已登记` 4,439、`run 已登记` 3,923、`monitorRun: 注册监听` 3,923、`result 落定` 3,219、`runs 已清理` 3,217、`startTask: 并发守卫命中` 709、`启动失败（已清理占位）` 516、`finalizeTask: paused 分支（人工暂停）` 364、`decide: 请求进入` 189、`resume: isRunning 预检拦截` 235、`assistStream: sessionQuery 不可用，降级为阶段级过程` 204 **[事实·强]**
- **真实任务子集（1,305 行）**：`store.mutateTask` 267、`saveTask` 89、`startTask 占位` 35、`run 已登记` 33、`monitorRun result 落定` 32、`paused 分支` 16、`decide 请求` **15（其中 3 次抛「已有运行中的 run」）**、`cancelTask` 6、`启动失败` 2（都是 `workflowEngine unavailable`）**[事实·强]**
- **错误按频次（全量，含夹具）** **[事实·强]**：

| # | 错误信息（归一化） | 次数 | 来源 |
|---|---|---|---|
| 1 | 无法确定任务工作目录：当前没有活跃会话可继承。请在「新建任务」表单中选择工作目录，或先打开任意一个会话再启动任务 | 235 | 夹具 |
| 2 | `SESSION_QUERY_SESSION_NOT_FOUND`（assist 过程流读取失败） | 199 | 两侧都有 |
| 3 | 任务 `task-w` 已有运行中的 run | 174 | 夹具 |
| 4 | 文件入参 `doc` 的上传已失效（暂存被清理或未上传成功） | 73 | 夹具 |
| 5 | 文件入参需要任务工作目录（cwd），当前为空 | 73 | 夹具 |
| 6 | 附件 `丢失的附件.md` 的上传已失效 | 49 | 夹具 |
| 7 | 附件需要上传服务，但当前上下文没有 uploads（请重启 dsh web 后重试） | 14 | 夹具 |
| 8 | `resolveWorkflowEngine: serviceFor 失败，回落 scope.get` (`registry boom`) | 12 | 夹具 |
| 9 | 已有运行中的 run（真实任务 3 次：`task-mtk8dxh2`×2、`task-mtk8re4c`×1） | 3 | 真实 |
| 10 | `workflowEngine unavailable in the owning agent scope` | 2 | 真实 |

→ **产品摩擦排序（真实侧）**：[推断] ① `workflowEngine` 取不到（agent preset 未挂载工作流能力）是**启动即失败**的致命路径；② 人工审批与"run 仍在"的并发守卫打架（决定按钮点下去报「已有运行中的 run」）是**审批体验**的主要挫败点；③ `subagent 无有效输出` 是**运行中**最主要的失败形态，但产品层只有手动重跑，没有自动重试。
→ `SESSION_QUERY_SESSION_NOT_FOUND` 出现在 **199/406 ≈ 49%** 的 AI 助手请求里，是**观察流读取**的高频降级 **[事实·强]**。

### 4.4 AI 助手对话（最"新"的功能，也最有真实热度）
- 日志里 **406 个不同 `requestId`**，分布在 **9 个活跃日**（09-10: 90、09-17: 160、09-19: 52、10-24: 36、10-23: 16、09-18: 20、09-11: 12、09-27: 12、09-20: 8）**[事实·强]**
- 其中 **206 个（51%）** 命中「sessionQuery 不可用，降级为阶段级过程」，**199 个**含 `SESSION_QUERY_SESSION_NOT_FOUND`，`runAssist: 无有效产出` 仅 1 次 **[事实·强]**
→ 解读：**AI 改流程是真实被高频使用的功能**（406 次），但"看得到助手推理/工具/正文流"这个卖点在近半会话里**降级成"只给阶段级过程"**，且产品 UI 没有把降级原因告诉用户（日志里有、界面无）→ 这是"承诺 vs 现实"的产品缺口 **[推断，证据强]**。

---

## 5. 版本与安装链路（可核对）

### 5.1 包元数据（`package.json`，1,885 字节）
- `name dsh-knj-workflow` / `version **2026.10.218**` / `type module` / `main ./lib/index.js` / `types ./lib/index.d.ts`
- `exports`：`.` / `./client` / `./orchestrator` / `./package.json`（**编排脚本被显式导出**，说明它是被宿主当 workflow script 加载的契约面）
- `dsh.bundle.patch: ./cordis.patch.yml`、`dsh.client: {platform: "web", inject: []}`
- `files: ["lib", "cordis.patch.yml", "README.md"]`（白名单打包）
- `engines: {node: ">=20", dsh: ">=0.1.1-rc.2 <0.3.0-0"}`
- `peerDependencies`（8 个，全在同一个版本窗口）：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-agent`、`dsh-commands`、`dsh-host-webserver`、`dsh-session`、`dsh-tools`、`dsh-workflow`（均 `>=0.1.1-rc.2 <0.3.0-0`）、`@deepseek-ai/schemastery >=3.18 <4`
- `devDependencies`：`dsh-client-locale/modules/ui-conversation/ui-slots 0.1.2-rc.1`、`dsh-client-runtime 0.1.1-rc.2`、`typescript 5`
- **本机宿主实际版本 `@deepseek-ai/dsh 0.2.1-rc.2`**（`C:\Users\MrYang\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\package.json`）→ **落在 `>=0.1.1-rc.2 <0.3.0-0` 窗口内，peer 声明与现实一致** **[事实·强]**

### 5.2 `cordis.patch.yml`（990 字节 / 18 行）—— bundle 层插条
```yaml
- insert:
    - id: knj-workflow
      name: dsh-knj-workflow
      config:
        httpPrefix: /devtask
```
注释里写了三条**版本考古证据**（比 README 更可信）：
1. `DSH 0.2.x 起不再需要（也不能）在宿主 realm 里点亮 workflow 引擎行`；
2. `workflow-worker-thread` 行 id 在 0.2 已不存在（补丁会报 entry not found）；
3. `workflowEngine` 自 `0.1.x rc.8` 起活在 **agent-preset 隔离 realm**，顶层 enable 只会 pending。
→ 结论：**这个补丁只做"插入插件行"，不再改宿主行**；`dataRoot`/`httpPrefix` 允许用户 profile 同 id 覆盖（后层胜）。这与 `index.js:58 inject = ['webServer','agents']`（**故意不 inject workflowEngine**）互为印证 **[事实·强]**。

### 5.3 实际安装链路（与 README 说法不同）
- README 写：`dsh plugin --profile web add dsh-knj-workflow`（npm 包名）。
- **本机实际**：`C:\Users\MrYang\.dsh\profiles\web\package.json` 里是
  `"dsh-knj-workflow": "file:D:/dsh-knj/_artifacts-0.2/dsh-knj-workflow-2026.10.218.tgz"`
  并且同一个文件把 `dsh-knj-workflow` 列进 `dsh.profile.bundles`（28 个 bundle 之一）。
- `.dsh-market/log.ndjson` 里**没有**本插件的安装记录；`.dsh-market/state.json` 的 `disabled` 列表里**有 `dsh-better-sidebar`** → [推断] 它是通过 `file:` 依赖 + pnpm 装的本地 tgz，不走市场。
- **npm 线上状态：[未知]**（`registry.npmjs.org` 在本机解析到非公网 IP，`web_fetch` 被环境策略拦下，无法核对 2026.10.218 是否已发布/是否为 latest）。

### 5.4 已装副本 vs 工作区（SHA-256 全量比对）
- `profiles/web/node_modules/dsh-knj-workflow`：**版本 2026.10.218，lib/ 37 个文件**
- 与工作区比对结果：`lib/` **37/37 个文件哈希完全一致**，`package.json` / `cordis.patch.yml` / `README.md` 三个根文件**哈希也完全一致**
→ **不存在"工作区领先于已装版本"的漂移；工作区 = 已装 = 声称的 218 发布内容** **[事实·强]**

### 5.5 三个 tgz 的打包产物证据
| 文件 | 字节 | 条目数 | 差异 |
|---|---|---|---|
| `dsh-knj-workflow-2026.10.216.tgz` | 247,083 | 39 | 基线 |
| `dsh-knj-workflow-2026.10.217.tgz` | 248,009 | 39 | 文件集合不变（内容迭代） |
| `dsh-knj-workflow-2026.10.218.tgz` | 251,321 | **40** | **新增 `lib/session-jump.test.js`** |

**打包白名单漏了该漏的、也没漏"不该发的"**：`files: ["lib", …]` 把 `lib/` 整目录打进包 → 发布包里含 **11 个 `*.test.js` + 2 个 `repro-*.mjs` + `index.d.ts`**（218 共 40 条目里 **13 个是开发产物**，216/217 是 12/39）**[事实·强]**。→ 用户装到的包里带测试与复现脚本（不是缺陷，但确实是"发布卫生"问题）。

### 5.6 与 `dsh-scheduler` 的耦合方式（双向、按服务名，弱于编译期但强于插件约定）
- **插件侧提供**：`index.js:407 createKnjWorkflowSchedulerService(store, bridge)` → `index.js:2327 ctx.provide('knjWorkflowScheduler', …)` **[事实·强]**
- **调度器侧消费**（`dsh-scheduler` 2026.9.197，同样 `file:` tgz 安装）**[事实·强]**：
  - `lib/executor.js:39` `if (task.executionKind === 'knj-workflow') { const workflow = ctx.get('knjWorkflowScheduler') }`；取不到 → `:42 'dsh-knj-workflow scheduler service is unavailable'`
  - `lib/executor.js:53` 还要求插件提供 `stageAttachments`，缺失时报 **「dsh-knj-workflow 缺少 stageAttachments（请更新该插件后重启 dsh web）」** → **调度器会因插件版本旧而给出明确升级提示**（跨插件版本契约）
  - `lib/routes.js:90-92` 同一服务，缺失时 HTTP **503**
  - `lib/types.js:12` `executionKind: 'knj-workflow' | 'prompt-session'`；`:60-83` 校验 `workflowPathInputs` / `workflowAttachments` **仅对 knj-workflow 生效**
  - `lib/store.js:44,321` 持久化时区分 `executionKind`
- **产品含义**：这是"可选但成对"的关系——单装插件只是任务编排器；装上 scheduler 才长成"定时跑流程"；两者通过一个**字符串服务名 + 一个额外方法（stageAttachments）**耦合，**没有共享类型/版本校验**，所以升级必须两边一起（`executor.js:53` 那句提示就是为此存在）**[推断，证据强]**。

### 5.7 仓库状态（发布链路的一个风险点）
- `git log` 最新提交 `9d3e1ef 2026-09-27`（**"sync to released 2026.9.192 state"**），**无 tag**。
- 工作区有 **7 个已修改未提交**文件（`cordis.patch.yml`、`lib/client.js`（+134 行）、`lib/index.js`、3 个测试文件、`package.json`）+ **2 个未跟踪**（`lib/session-jump.test.js`、`reo/`）。
→ **`package.json` 写 2026.10.218，但 git 历史停在 2026.9.x 的同步点**；发布内容与仓库历史脱节，只能靠 tgz + 安装副本对齐（本报告正是用哈希对齐验证的）**[事实·强]**。
- `.gitignore` 排除 `*.tgz`、`.wiki/`、`.dsh-edit-review.json*`、`node_modules/`、`release/`。**三个 tgz 不进仓库**（只在本地留档）。

---

## 6. 真实使用"到底证明了什么"（结论层）

**证实的**（都有盘上数据支撑）**[事实·强]**：
1. 核心闭环**真的跑通了**：11 个任务 `success`，其中含人工审批通过（5 次「通过」决策）。
2. **阶段重跑 / 断点续跑**真的被用过（`submit` ×4、`fix` ×3 会话累积）；恢复后不会重跑已完成阶段。
3. **人工审批回路**真的被用过 13 次（含 6 次驳回→回流修复），且意见注入下游（`feedback` 有内容如「1+2=」「踩踩踩」）。
4. **附件物化**真的发生过（`.knj-inputs/<taskId>/地址.txt` 379B），`.gitignore` 隔离真的落了 3 处。
5. **AI 改流程**是使用热度最高的新功能（406 次请求、9 天）。
6. 多工作目录下都能用（4 个不同 cwd）。

**没被证实的（= 产品承诺尚未被真实场景压测）**：
- 十万字长需求 / `requirement.md` 落盘路径：**0 次**（真实需求最长 5 字）。
- 声明式文件入参（`inputs` 声明）：**8 个工作流全为空**，真实任务 0 例。
- 并行网关（`gateway-and`）：**0 个节点**（只有单测夹具里出现）。
- `skill` 字段：**0 次使用**（虽然有两个工作流名叫"skill 可见性验收"）。
- 归档/恢复：**0 个任务归档**。
- 模板导出→导入的完整往返：只有 `wf-dev-flow1` 这个"同名同构副本"作为**间接**证据 **[推断]**。

**当前真实用途画像**：24 个任务里标题为 `test1/test2/test3/测试/测试通过/测试网关/柔柔弱弱/快速测试` 的占绝大多数，且 5 个直接在本插件仓库 cwd 里跑 → **本机数据是"开发者自测/造数"为主，不是外部用户的生产数据**。报告里所有频次结论都应带着这个前提读 **[事实·强，重要]**。

---

## 7. 产品短板与边界

### 7.1 README 引用的文档不存在（3 处断链）
| README/代码中的引用 | 位置 | 是否存在 |
|---|---|---|
| `./DESIGN.md`（"详细设计文档见…架构、数据模型、Host/Client 设计、编排器、踩坑记录、验证记录"） | `README.md:5` | ❌ **不存在** |
| `./design/task-attachments.md`（"详见…"） | `README.md:13` | ❌ **不存在（整个 `design/` 目录都不存在）** |
| `design/new-task-requirement-input.md §3.2/§3.3`（代码注释也引它） | `lib/client.js:2581` | ❌ **不存在** |

→ README 开篇第一句就把用户引到一个 404 文件，这是**最容易被外部评审抓到的硬伤** **[事实·强]**。

### 7.2 截图与当前代码/README 不一致（三处可见漂移）
| 截图（2026-08-28） | 当前代码 | README |
|---|---|---|
| 「需求描述（**必填**）」 | 「需求描述（**可选**）」`client.js:2742` | "可选项——不填也能建任务" ✓ |
| 有「**标题**」输入框 | **没有标题输入框**，`client.js:2896` 注释「标题不再由用户填写」 | "因此表单没有标题输入框" ✓ |
| 弹窗里**没有附件区** | 有内置附件区 + 文件类型入参（`lib/attachments.js`、`lib/uploads.js`） | "永远有一个「附件（可选）」区" |
| 左栏入口叫「**开发任务**」 | DOM 注入的入口文案是「**流程设计**」`client.js:3284`（aria-label 流程设计，title「打开流程设计看板（流程运行 / 流程设计）」） | "左侧栏底部「新建任务」入口 + 右侧栏两个 tab" |
| 面板形态：任务/工作流两个 tab（像右栏抽屉） | `client.js:507` 注释「中央「开发任务」页签：铺满主区」、`:624`「主板化：主区接管」 | "右侧栏 better-sidebar 两个 tab" |

补充事实：`better-sidebar` 在本机**未安装**（`profiles/web/node_modules` 无此包），且在 `.dsh-market/state.json` 里被**显式 disabled**；插件对它是 `ctx.get('betterSidebar')` 可选获取（`client.js:3876`），缺失时降级。→ README 的"右侧栏 tab"描述与当前挂载方式（DOM 注入 + 主区接管）**已经脱节** **[事实·强 + 推断]**。

### 7.3 README 的 HTTP API 表只覆盖一半
README 列 12 条；代码实际注册 **24 条**（`index.js:1601–2137`）。README **缺**：`GET /models`、`GET /diag`、`POST /tasks/:id/decide`（人工审批的核心写接口！）、`POST /tasks/:id/archive`、`POST /tasks/:id/restore`、`DELETE /tasks/:id`、`GET /tasks/:id/results`、`GET /tasks/:id/file`，且未区分 `POST /workflows`（新建）与 `PUT /workflows`（保存） **[事实·强]**。

### 7.4 单机 / 单租户 / 无鉴权（结构性边界）
- 数据根是 `~/.dsh/dev-orchestrator`（单用户目录），`GET /devtask/health` 直接把 `store.root` 返回给前端。
- HTTP 路由挂在 `ctx.webServer.register({kind:'prefix', path:'/devtask'})`（`index.js:2210`），**没有用户身份/权限校验** → 同源页面（或同机任意能发请求的进程）都能建/跑/删任务 **[事实·强]**。
- 任务与 **agent scope/preset** 强绑定：`workflowEngine` 取不到就启动失败（真实发生 2 次），错误文案直接把内部概念抛给用户（"is an agent preset with workflow support mounted?"）→ **部署形态一变就整条链路不可用** **[事实·强]**。
- 全部路径按 Windows 反斜杠假设（`D:\workspace\...`），`cwd` 继承依赖"当前有活跃会话"（235 次失败的根因）。

### 7.5 运营/可观测性缺口
- 调试日志单文件累积（7 周 3.0MB，**未见轮转痕迹**，只有 `knj-host-debug.log` 一个文件）；日志里 **95% 是测试夹具噪音**，真实事故排查需要自己按 taskId 过滤 **[事实·强]**。
- 前端只能看"阶段级过程"，`sessionQuery` 不可用时的降级**不告知用户**（406 请求中 206 次降级） **[事实·强 + 推断]**。
- 失败分类粗：`failed` 一种状态同时覆盖"subagent 无输出""死循环熔断""引擎不可用"三种完全不同的处置需求（前者重跑、中者改图、后者改环境）→ 用户无法从状态判断该做什么 **[推断]**。

### 7.6 其他小口径问题
- 决策标签跨工作流不统一（通过/驳回/不通过，13 条记录 3 种写法），统计与埋点会打架。
- 1 个任务目录是空壳（`task-mu90ptev-d36f1926`）→ 创建流程中断会留垃圾目录，无清理机制被发现。
- `pending` 是合法任务状态且占一个看板列，但真实数据 0 例（拖回待执行的入口存在，未被验证）。
- 有 1 个 `task.json` 落盘带 **UTF-8 BOM**（`task-mt619d2v`），导致朴素 `JSON.parse` 直接失败 → 说明写盘侧没有统一 "no BOM / LF" 约束（仓库有 `line-endings.test.js` 但只覆盖行尾）**[事实·强]**。

---

## 8. 给下游（"每个功能怎么实现"章节）的用户侧上下文

写作建议：**先讲用户看到什么，再讲代码在哪**。每节的"用户侧一句话"可直接复用：

1. **工作流编辑器** — 用户侧："我在画布上拖 4 种节点（任务/排他网关/并行网关/人工），从右侧圆点拉线，点节点改配置；改错了按 ↶。" 实现侧：`client.js` 图编辑器类 + `graph.js NODE_TYPES/validateWorkflow` + `workflows.json`（`schemaVersion:2`、每工作流 `revision` 自增，真实最大 17）。
2. **新建任务** — 用户侧："我只填一段需求就点创建，标题系统自己起；不填需求也行（真实有 4 个空需求任务）；可选附件、可选文件入参、可选执行模型。" 实现侧：`POST /tasks` + `lib/requirement.js`（`INLINE_MAX=8000`/`HEAD_MAX=6000`/标题 50 码点）+ `attachments.js`(20 个) + `uploads.js`(32MB/24h) + `GET /models` 读 `settings.yaml`。
3. **执行引擎** — 用户侧："点完就能干别的，回来看进度条。" 实现侧：`WorkflowBridge.startTask → resolveWorkflowEngine → ctx.workflowEngine` 启 `orchestrator.js`；节点级 `maxRuns` 默认 3 防死循环（真实熔断过 1 次：`fix` 跑 4 次）；`gateway-xor` 按 `when{field,op,value}` 路由（真实条件：`level eq high/low`、`passed eq true/false`）；`human` 节点返回 null 暂停。
4. **进度呈现** — 用户侧："一行步骤条 + 每阶段时长；看板 5 列。" 实现侧：`BOARD_COLUMNS`（L2930）+ `stageStates`（真实 `done/skipped/pending`）+ 轮询 `GET /tasks/:id`；"N 阶段"= `nodes.filter(type==='task').length`（这是 README 与 UI 都容易误解的点：**人工节点不算"N 阶段"**，但它会出现在步骤条里）。
5. **人工审批** — 用户侧："按钮文字是我的流程里配的（通过/驳回 或 通过/不通过）。" 实现侧：`POST /tasks/:id/decide` + 去向 `routes[{label,to,tone}]` + `decisions[]` 审计 + `approve/reject` 旧值兼容；`displayFrom` 决定审批时给他看哪个上游产物（真实配了 `verify`）。
6. **重跑/续跑/取消/归档** — 用户侧："失败阶段单独重跑，不用整条重来。" 实现侧：`POST /rerun-stage`（后续阶段重置 pending，L2007-2008）、`/resume`（`resumeFrom`）、`/cancel`、`/archive|/restore`；断点：`tasks/<id>/stages/<stageId>.json`（真实 37 个文件，文件名 = 阶段 id，如 `fix.json`、`submit.json`、`task-1.json`）。
7. **定时调度** — 用户侧："在调度器里选我的工作流，按 Cron 跑，还能只给文件路径（不用先上传）。" 实现侧：`knjWorkflowScheduler` 服务（`index.js:407/2327`）↔ `dsh-scheduler` 的 `executor.js/routes.js/types.js`；`pathInputs` 相对路径按 cwd 解析 + 启动前存在性校验（日志里有 6 次"指向的文件不存在"的夹具验证）。
8. **AI 改流程** — 用户侧："用一句话让它改图，改动一次撤销，能看它在想什么。" 实现侧：`POST /assist`(202) + `GET /assist/progress?since=` 增量轮询 + `assist-prompt/rules/edits/script` 四件套（动作：`add_node/set_node/remove_edge/add_edge/set_routes`，Host 逐条语义预检 + 全图校验）；**真实风险**：`sessionQuery` 缺失时自动降级（51% 请求），过程流只剩阶段级（见 §4.4）。

---

## 9. 未知 / 无法验证清单（保持诚实）
1. **npm 线上版本与发布时间**：`registry.npmjs.org` 在本机解析到非公网 IP，`web_fetch` 被拦；无法确认 2026.10.218 是否已发布、README 的 `npmjs.com/package/dsh-knj-workflow` 链接是否还有效。**[未知]**
2. **`design/` 系列文档是"从未存在"还是"曾存在后被删"**：当前工作区与 git 历史里都没有；`git log --all` 未找到相关提交（仅查了主分支最新 12 条）。**[未知，倾向"从未提交"]**
3. **日志前 12 天（2026-08-28 之前）的使用痕迹**：日志从 2026-09-02 才开始，插件 8 月底已发版 → 更早的真实使用无可查证据。**[未知]**
4. **`dsh-knj-reqwork`（同族插件，本机 disabled）与本插件的分工**：只在 profile 里看到它被 disable，无交叉调用证据。**[未知]**
5. **调度器真实触发次数**：`knj-host-debug.log` 里没有 scheduler 事件（调度器日志在别处/未开启），只有 `uploads/调度附件A|B.txt` 间接证明联动被测过。**[信息不足]**
6. **`assets/screenshots` 三张图是否还会更新**：`files` 白名单不含 `assets/`，市场展示图与 npm 包内 README 不同步的问题会持续。**[推断]**

---

## 10. 我最确定的 5 个产品事实（速览）

1. **产品形态 = 配置驱动的多 agent 流程图执行器**：8 个工作流 / 54 节点 / 5 类节点（`start/end/task/gateway-xor/human`，`gateway-and` 真实 0 使用）；旗舰流程 `wf-dev-flow` 迭代 **17 个版本**、6 个任务阶段 + 2 个排他网关 + 1 个人工审批节点。证据：`workflows.json` + `reo/tmp/wf-detail.mjs` 输出。
2. **真实跑过、也真实卡过**：23 个任务 `success 11 / failed 6 / waiting-human 4 / running 1 / cancelled 1`；39 个阶段执行拉起 **51 个 subagent 会话**；13 条人工决策（通过 5 / 驳回 6 / 不通过 2）；6 个失败任务分属三类：`subagent 无有效输出` ×3、节点级死循环熔断 ×1、`workflowEngine unavailable` 启动失败 ×2。证据：`~/.dsh/dev-orchestrator/tasks/*/task.json`。
3. **3MB 日志里只有 5.3% 是真实任务**（1,305/24,557 行，21 个真实 taskId vs 481 个夹具 id）——任何"高频错误 = 用户痛点"的结论都必须先按 taskId 过滤，否则会把单测噪音当产品缺陷。证据：`knj-host-debug.log` + `reo/tmp/log-split.mjs`。
4. **工作区 = 已安装副本 = 218 发布内容**（`lib/` 37 个文件 + 3 个根文件 SHA-256 全一致），宿主 DSH `0.2.1-rc.2` 落在 peer 窗口 `>=0.1.1-rc.2 <0.3.0-0` 内；但 **git 历史停在 2026-09-27 的 2026.9.192 同步点、无 tag、7 个文件未提交** → 发布靠 tgz 而非仓库历史。证据：哈希比对 + `git log/status`。
5. **产品文档有三处硬伤**：README 首句指向的 `DESIGN.md`、`design/task-attachments.md`（以及代码注释引的 `design/new-task-requirement-input.md`）**全部不存在**；三张界面图是 **2026-08-28** 的老 UI（与当前"需求可空、无标题输入框、有附件区、入口叫流程设计"冲突）；README HTTP API 表只写 12/24 条（漏掉人工审批的 `POST /tasks/:id/decide`）。证据：`README.md:5,13`、`git log -- assets/screenshots/*`、`client.js:2742/2896/3284`、`index.js:1601-2137`。

---

## 11. 验证记录：当前代码的测试套件是绿的（2026-10-24 实测）

**命令**（Node v24.12.0，在 `D:\dsh-knj\dsh-knj-workflow` 下，只读运行、无文件改动）：

```powershell
$files = Get-ChildItem lib -Filter *.test.js | ForEach-Object { $_.FullName }
node --test --test-reporter=spec @files
```

**结果 [事实·强]**：`tests 389 / pass 389 / fail 0 / cancelled 0 / skipped 0`，`duration_ms 3751`，**exit code 0**（23 个测试文件全部执行）。

**踩坑提醒（重要，别复现）**：`node --test lib` 会**假绿**——Node 把目录参数当成单个测试入口，只报 `tests 1 / pass 1`。必须显式展开文件列表（或给 glob）。我第一次就命中了这个假绿，记录在此。

**测试名与第 2/7 章结论互相印证**（说明"截图/README 已过时"不是我的主观判断，而是被 UI 回归测试固化的当前行为）：
- `UI：需求描述标签改为「可选」，标题输入框整块移除`
- `UI：标题由 Host 依需求描述自动生成（客户端不再提交 title）`
- `UI：提交按钮不再以「需求描述非空」为门槛（真非必填）`
- `UI：左侧栏入口文案/无障碍属性为「流程设计」`
- `UI：主看板（WorkbenchView）两个页签命名为「流程运行」/「流程设计」`
- `UI：任务详情支持「运行效果图」视图（流程图/列表切换 + SVG 画布 + 点击节点详情）` ← README 完全没提这个功能
- `UI：审批预览优先接入 dsh-better-sidebar（tryOpenSidebar 同步 openTab editor，失败回退内嵌）` ← 印证 better-sidebar 是"可选增强"
- `UI：内置附件不需要任何工作流声明` / `UI：需求阈值/体积提示常量是 Host 常量的镜像（防两处漂移）`

**推论**：套件绿 + 已装副本与工作区哈希一致（§5.4）→ **本报告所有基于"当前代码"的产品结论，其代码基线是已通过 389 项测试的那一份**；`reo/` 与 `reo/findings/product.md` 是纯粹的文档新增，不在 `files` 白名单内，不影响发布产物。

---

### 附：可复跑的采集脚本（`reo/tmp/`）
| 脚本 | 用途 |
|---|---|
| `wf-summary.mjs` | `workflows.json` 总览：8 工作流 / 节点类型分布 / 字段并集 |
| `wf-detail.mjs` | 旗舰流程 `wf-dev-flow` 逐节点明细 + 全部 8 个工作流对照 |
| `tasks-summary.mjs` / `tasks-summary2.mjs` | 24 任务：字段并集 / 状态分布 / 阶段状态 / 错误 / decisions / humanState / inputs |
| `durations.mjs` | 任务与阶段耗时、会话数、阶段 id 频次 |
| `decisions.mjs` | 决策标签精确计数、标题派生统计、cwd 分布 |
| `log-summary.mjs` / `log-events.mjs` / `log-split.mjs` | 日志：事件直方图、错误归一化、**真实任务 vs 夹具切分** |
| `assist-stats.mjs` | AI 助手 406 请求的降级/失败统计与日期分布 |

（`reo/tmp/` 下仅临时脚本，可随时删除；正式产出只有本文件。）
