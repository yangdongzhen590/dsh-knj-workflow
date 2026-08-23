# dsh-knj-workflow

**开发任务编排插件**（DeepSeek Harness）：配置驱动的工作流 + 开发任务管理 + 可视化阶段进度。

> 📖 **详细设计文档见 [DESIGN.md](./DESIGN.md)**（架构、数据模型、Host/Client 设计、编排器、踩坑记录、验证记录）。

## 功能

- **工作流管理**：可新增 N 个工作流，每个工作流由多个阶段组成；阶段行为由 `prompt`（提示词）+ 可选 `skill` 定义
- **开发任务**：创建任务并绑定工作流，自动启动执行
- **可视化进度**：右侧栏「开发任务」tab 横向步骤条展示每个阶段状态（待执行/运行中/完成/失败），实时刷新
- **阶段重跑 / 继续**：失败的阶段可点击「重跑」，暂停/失败的任务可点击「继续」——基于断点持久化（每阶段结果落盘）
- **斜杠命令**：`/dev-task new <标题>`、`/dev-task list`、`/dev-task status <id>`、`/dev-task wf`
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
  workflows.json                    # N 个工作流定义
  tasks/<taskId>/task.json          # 任务元数据 + 阶段状态
  tasks/<taskId>/stages/<stageId>.json  # 阶段断点产物
```

## 安装

```sh
# 在插件目录打包
pnpm pack                     # 生成 dsh-knj-workflow-0.1.0.tgz

# 安装到 dsh web profile（重启 dsh web 生效）
dsh plugin --profile web add ./dsh-knj-workflow-0.1.0.tgz
```

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
| GET/POST | `/devtask/tasks` | 任务列表 / 创建（绑定工作流并启动） |
| GET | `/devtask/tasks/:id` | 任务详情（含阶段状态） |
| POST | `/devtask/tasks/:id/start` `/cancel` `/resume` | 启动 / 取消 / 继续 |
| POST | `/devtask/tasks/:id/rerun-stage` | 重跑指定阶段 |
| GET | `/devtask/tasks/:id/stages/:stageId` | 阶段断点产物 |

## 编排器参数

- `args.config`：工作流定义（`{ name, description, stages: [...] }`）
- `args.task`：任务元数据（`{ id, title, taskDir }`）
- `args.resumeFrom`：从某阶段继续（之前阶段读缓存）
- `args.rerunStage`：只重跑某阶段（其余读缓存）
