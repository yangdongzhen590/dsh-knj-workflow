# dsh-knj-workflow

**开发任务编排插件**（DeepSeek Harness）：配置驱动的工作流 + 开发任务管理 + 可视化阶段进度。

> 📖 **详细设计文档见 [DESIGN.md](./DESIGN.md)**（架构、数据模型、Host/Client 设计、编排器、踩坑记录、验证记录）。

## 功能

- **工作流管理**：可新增 N 个工作流，每个工作流由多个阶段组成；阶段行为由 `prompt`（提示词）+ 可选 `skill` 定义
- **模板导入/导出**：工作流列表与图编辑器均支持把模板导出为 `.workflow.json` 文件、从文件导入（跨机器移植）；导入后先进入编辑器检查再保存，同 ID 冲突会提示
- **开发任务**：创建任务并绑定工作流，自动启动执行
- **需求描述（可选，可长）**：新建任务弹窗里需求描述是**可选项**——不填也能建任务；标题由系统依描述自动生成（首行前 50 字，空则时间戳占位），因此表单没有标题输入框。支持粘贴十万字级长文本；超过 8000 字的完整需求会随任务落盘 `requirement.md`，AI 节点 prompt 只注入头部摘录 + 文件指针（不丢内容、不炸上下文）。任务详情可展开查看/复制完整需求，看板搜索支持搜需求正文
- **内置通用附件（无需任何声明，推荐）**：新建任务弹窗里永远有一个「附件（可选）」区，可一次多选若干本地文件（docx / md / 表格都行），也能逐个移除。Host 在**启动前**把它们落到 `<工作目录>/.knj-inputs/<任务 id>/`，并把**换行拼接的绝对路径串**写进 `inputs.附件`——节点 prompt 里写 `${inputs.附件}` 拿到清单，**自己写提示词解析文档**。同名文件自动加序号（`2-名字.ext`）不覆盖；暂存失效时**拒绝启动**并报出文件名（不静默少文件）。支持最多 20 个附件，单文件上限 32MB。详见 [design/task-attachments.md](./design/task-attachments.md)
- **文件类型任务输入参数（声明式，只传路径）**：编辑器里的「输入参数」声明参数（名称 / 显示名 / 必填 / 类型：文本｜文件）。**文件**类型的参数在新建任务时选文件：上传后由 Host 在**启动前**落到 `<工作目录>/.knj-inputs/<任务 id>/`，并把**绝对路径**写进 `inputs.<参数名>`——节点用 `${inputs.参数名}` 拿到路径，**文档解析由节点自己写提示词完成**（不注入文件内容，也不塞进需求描述）。该目录自带 `.gitignore`（内容 `*`），默认不进用户版本库；单文件上限 32MB；未提交的上传暂存在 `~/.dsh/dev-orchestrator/uploads/`，24 小时后自动清理
- **文件入参还支持「按路径引用」（给定时任务用）**：同一参数可以只给一个路径（`pathInputs`）：相对路径按任务工作目录解析成**绝对路径**，且**启动前校验文件确实存在**——不存在就拒绝启动并报出参数名与路径（路径引用意味着每次触发读**当时**的文件，不做快照）。必填文件入参由「上传」或「路径」**任一种**满足；`knjWorkflowScheduler.listWorkflows()` 返回各工作流声明的入参，调用方据此渲染字段
- **可视化进度**：右侧栏「开发任务」tab 横向步骤条展示每个阶段状态（待执行/运行中/完成/失败），实时刷新
- **阶段重跑 / 继续**：失败的阶段可点击「重跑」，暂停/失败的任务可点击「继续」——基于断点持久化（每阶段结果落盘）
- **斜杠命令**：`/dev-task new <标题>`、`/dev-task list`、`/dev-task status <id>`、`/dev-task wf`
- **AI 助手对话配置（新）**：在图编辑器里用自然语言改流程图——对话坞位于编辑器下半区（左=对话过程 / 右=指令输入），AI 返回「回复 + 编辑动作序列」，逐条校验后实时应用到画布草稿；整轮改动一次撤销，可查看推理/工具/正文流与 token 用量
- **定时调度集成（可选）**：为 `dsh-scheduler` 提供进程内 `knjWorkflowScheduler` 服务；定时触发时按最新保存的流程定义创建并启动任务，历史可直达该任务详情
- **UI 融入原生**：左侧栏底部「新建任务」入口 + 右侧栏两个 tab（better-sidebar 扩展点），全部使用 DSH 原生设计令牌（`--dsw-*`）

## 架构

```
┌─ Client 端（lib/client.js）───────────────────────────────┐
│  左侧栏 sidebar.footer.action →「➕ 新建任务」              │
│  右侧栏 better-sidebar →「开发任务」「工作流」两个 tab        │
└──────────────┬──────────────────────────────────────────┘
               │ fetch('/devtask/...') 同源 HTTP
┌──────────────▼──────────────────────────────────────────┐
│  Host 端（lib/index.js）                                  │
│  DevTaskStore（JSON 持久化） + HTTP API + /dev-task 命令   │
│  WorkflowBridge：从 parent agent 作用域取 workflowEngine    │
│  （rc.8 起引擎位于 agent preset realm，非 host realm）      │
└──────────────┬──────────────────────────────────────────┘
               │ ctx.workflowEngine（script = lib/orchestrator.js）
┌──────────────▼──────────────────────────────────────────┐
│  编排器（lib/orchestrator.js）支持 resumeFrom / rerunStage │
│  每阶段子 agent 结果落盘 <taskDir>/stages/<stageId>.json   │
└─────────────────────────────────────────────────────────┘

数据目录（默认）：~/.dsh/dev-orchestrator/
  workflows.json                    # N 个工作流定义（含 inputs 声明：type = text | file）
  uploads/<uploadId>/<文件>          # 文件入参的**暂存**：表单打开时任务还没建，先落这里
                                    # （24h 自动清理；启动前物化进工作区并从暂存删除）
  tasks/<taskId>/task.json          # 任务元数据 + 阶段状态（需求描述全文存这里）
  tasks/<taskId>/requirement.md     # 仅当需求超 8000 字：完整需求全文，**启动前**统一写出
                                    # （落盘在 WorkflowBridge.startTask 完成，HTTP 路由 / 调度器 /
                                    #   /dev-task 命令 / 续跑 rerun+resume 全部入口都覆盖）
  tasks/<taskId>/stages/<stageId>.json  # 阶段断点产物

工作目录内（文件入参/附件的最终位置，按任务隔离）：
  <cwd>/.knj-inputs/.gitignore      # 内容 `*`：上传文件默认不进版本库
  <cwd>/.knj-inputs/<taskId>/<文件>  # 声明式入参：节点用 ${inputs.参数名} 拿路径
                                    # 内置附件：节点用 ${inputs.附件} 拿换行拼接的路径串
```

## 安装

```sh
dsh plugin --profile web add dsh-knj-workflow
```

> npm 包 [`dsh-knj-workflow`](https://www.npmjs.com/package/dsh-knj-workflow)；安装后重启 dsh web 生效。`dsh-scheduler` 可独立安装；同时安装本插件后，调度器才会显示「KNJ 工作流」任务类型。

配置（可选，在 profile 的 `cordis.patch.yml` 中按 id `knj-workflow` 覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `dataRoot` | `~/.dsh/dev-orchestrator` | 数据存储目录 |
| `httpPrefix` | `/devtask` | HTTP API 前缀 |

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/devtask/health` | 健康检查 |
| GET/POST/PUT | `/devtask/workflows` | 工作流列表 / 保存 |
| DELETE | `/devtask/workflows/:id` | 删除工作流 |
| GET/POST | `/devtask/tasks` | 任务列表 / 创建（绑定工作流并启动）· GET 支持 `?archived=1` 与 `?q=<关键词>`（Host 侧按标题/需求正文/工作流 id 全文过滤；列表项不含需求正文，只给 `descriptionChars`）· POST 可带 `fileInputs: { <参数名>: { uploadId, name } }`（必填文件入参缺失 → 400） |
| GET | `/devtask/tasks/:id` | 任务详情（含阶段状态与需求描述全文） |
| POST | `/devtask/uploads` | 文件入参上传暂存：`{ name, dataBase64 }` → `{ uploadId, name, size }`；文件名先消毒成 basename（不可用 → `invalid-name`），单文件上限 32MB（`file-too-large`），失败 400 + `{ error, code }` |
| POST | `/devtask/tasks/:id/start` `/cancel` `/resume` | 启动 / 取消 / 继续 |
| POST | `/devtask/tasks/:id/rerun-stage` | 重跑指定阶段 |
| GET | `/devtask/tasks/:id/stages/:stageId` | 阶段断点产物 |
| POST | `/devtask/assist` | AI 助手对话：`{ workflow, message, history? }` → `202 { requestId }`（异步启动） |
| GET | `/devtask/assist/progress?id=&since=` | 对话过程：`{ events[], stream{text,reasoning,tools,usage}, done, result? }` |

## AI 助手对话配置

在「流程设计」打开任一工作流 → 编辑器下半区出现对话坞，用自然语言描述改动即可（如
「在 coding 后加一个代码验证节点，输出 passed（布尔），通过走人工评审、失败回到 coding」）。

- **改动可控**：AI 返回结构化编辑动作（add_node / set_node / remove_edge / add_edge / set_routes …），
  Host 逐条做语义预检 + 全图校验，非法动作被拒并说明原因（不会写出坏图）；整轮改动 = 一次撤销步
- **遵守流程配置规范**：内置本插件的流程配置规范（图形态、节点选型、输出字段类型、网关条件、
  人工审批去向、并行限制、引用语法、运行语义与反模式），规范与 `validateWorkflow` 由一致性测试绑定
- **过程可见**：对话坞实时显示助手推理、正文流、工具调用与 token 用量；可跳转查看助手完整会话
- **独立通道**：经 workflow 引擎派专用 subagent，不占用主对话上下文；「＋ 新对话」可随时清空对话重来（画布草稿保留）

## 编排器参数

- `args.config`：工作流定义（`{ name, description, stages: [...] }`）
- `args.task`：任务元数据（`{ id, title, taskDir, inputDescription }`）——`inputDescription` 由 Host 预计算：
  需求描述未超阈值时是全文，超阈值时是「前 6000 字 + 省略说明 + 完整需求文件路径」。
  脚本沙箱内没有 `require`，**不要在脚本里重新实现这份阈值逻辑**（与 `lib/requirement.js` 会漂移）
- `args.resumeFrom`：从某阶段继续（之前阶段读缓存）
- `args.rerunStage`：只重跑某阶段（其余读缓存）
