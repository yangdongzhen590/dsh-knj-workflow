# dsh-knj-workflow · Client/UI 侧代码级逆向（lib/client.js）

- **被测版本**：`package.json:3` = `2026.10.218`（`dsh.client.platform = "web"`，`package.json:32-35`）
- **实测规模**：`lib/client.js` **4293 行 / 296,078 B（289 KiB）**，单文件、无构建链、直接维护产物
- **证据强度约定**：`【实证】`= 源码/文件行号可查；`【推断】`= 由源码+DSH 契约推导，未运行验证；`【未知】`= 本仓库内无法判定
- **行号口径**：全部为当前工作区 `lib/client.js` 的真实行号。为节省版面，正文/表格里出现的**裸行号**（如 `1301-1381`、`4288`）一律等价于 `lib/client.js:1301-1381` / `lib/client.js:4288`；需要直接 grep 的锚点已写成完整形式 `lib/client.js:N`。

---

## 0. 先读：任务简报 vs 源码实际的 5 处偏差

> 简报描述的 UI 结构来自更早版本（README 也仍停留在旧结构）。以下以源码为准。

| # | 简报/README 的说法 | 源码实际（v2026.10.218） | 证据 |
|---|---|---|---|
| D1 | 左侧栏「新建任务」入口 | **已移除**，注释明确记录「用户确认移除」；现在左侧栏只有 1 个入口「流程设计」，新建任务按钮在工作流看板头部 | 【实证】`lib/client.js:3349`、`lib/client.js:3204` |
| D2 | 右侧栏（better-sidebar）「开发任务」「工作流」两个 tab | **不再注册任何右侧栏 tab**；`conversation.view` 页签也已移除，改为「左侧 DOM 入口 + 主区接管看板」 | 【实证】`lib/client.js:3362-3363`、`lib/client.js:3264-3268` |
| D3 | 两个 tab 名「开发任务」「工作流」 | 实际 tab 名为 **「流程运行」/「流程设计」**（主看板与遗留 Overlay 两处同步改名） | 【实证】`lib/client.js:3162-3163`、`lib/client.js:766-767` |
| D4 | 依赖 `@deepseek-ai/dsh-client-*` 注册 UI | **运行时零 dsh-client-\* 依赖**：bundle 只 `require("react")` 与 `require("react-dom/client")`；这些包只在 `devDependencies` 里（测试/类型用途） | 【实证】`lib/client.js:8-9`、`package.json:52-59`；加载契约见 §1.1 |
| D5 | 4243 行 / 289KB | 4293 行 / 296,078 B。217→218 净增 84 行（会话跳转适配层） | 【实证】`reo/tmp/gz-2026.10.217/package/lib/client.js`（4209 行）对比 |

**版本增量**（217→218，客户端的唯一实质变化）：新增 DSH 0.2.x 会话跳转适配层 `lib/client.js:19-117`（`uiWorkspace.openSession` 替代已移除的 `sessions.open`，并为裸子会话 id 合成 `{mode:'unknown'}` address），配套新增 `lib/session-jump.test.js`。

---

## 1. 客户端入口与注册

### 1.1 模块形态与加载契约【实证】

`lib/client.js` 不是 ESM，而是 DSH Web 的 **factory-form bundle**：

```js
window.__ModuleLoader__.load({            // client.js:1
  id: "dsh-knj-workflow",                 // client.js:2
  factory: (require) => {                 // client.js:3
    var module = { exports: {} }; ...     // client.js:4-6
    let react = require("react");         // client.js:8
    let react_dom_client = require("react-dom/client"); // client.js:9
```

- 契约来源：DSH `@deepseek-ai/dsh-client-modules` 的 README 说明「浏览器插件包在 package.json 中以 `platform:'web'` 声明 `dsh.client`，导出 `./client` bundle」；其自身产物也是同一形态（`node_modules/@deepseek-ai/dsh-client-modules/lib/client.js:1-6`）。
- 宿主把 `package.json` 的 `exports["./client"]`（`package.json:24`）作为 `/plugins` 下的 bundle 提供；factory 在首次 require 时**物化并缓存**（`dsh-client-modules/lib/client.js:17-22`）。
- `require` 只允许 platform seed 与已注册模块表内的 specifier；因此 `react` / `react-dom/client` 属于平台种子，其余 `@deepseek-ai/dsh-client-*` 在本 bundle 中**一次都没被 require**（全文件仅 2 处 `require(`，见 `lib/client.js:8-9`）【实证】。
- 结论：这是一个**自包含、零 dsh-client-\* 依赖**的客户端插件，UI 靠原生 DOM + 自建 React root 挂载，而非 DSH 的 slot/扩展点体系。

### 1.2 导出面（Cordis 客户端插件协议）【实证】

| 导出 | 行号 | 含义 |
|---|---|---|
| `exports.apply` | `lib/client.js:4289` | Cordis 客户端插件入口（`function apply(ctx)`，`lib/client.js:3342`） |
| `exports.inject` | `lib/client.js:4290` | 服务依赖声明 = **空数组 `[]`**（`lib/client.js:3265`），即不阻塞等待任何服务 |
| `exports.__test` | `lib/client.js:4288` | 为 node:test 暴露 7 个内部纯函数：`parseWorkflowFile, exportWorkflowFile, assistDiff, assistHistory, openSessionById, refreshSubagentCatalog, jumpToSubagentSession, resolveSubagentTarget` |

`package.json` 里的 `dsh.client.inject: []`（`package.json:34`）与代码侧 `inject = []` 一致：**不声明跨包加载顺序**。

### 1.3 `apply()` 实际只做 4 件事【实证】`lib/client.js:3342-3364`

1. 抓 3 个可选服务快照：`sessions` / `uiWorkspace` / `workspaces`（`3343-3345`），并把 `ctx` 存到模块级 `_ctx`（`3346`）；
2. `ensureStyle()` 注入全局 `<style>`（`3347`）；
3. `ctx.effect(...)` 挂「流程设计」左侧栏 DOM 入口，返回清理函数（`3352`）；
4. `ctx.effect(...)` 注册 `window` 事件 `dsh-knj-workflow:open-task`，用于调度器直达任务（`3353-3360`）。

**没有任何** `ctx.slots(...)` / `ctx.view(...)` / `ctx.command(...)` / `ctx.menu(...)` 调用。注册侧只有「DOM 注入 + 全局事件 + 服务消费」三种手段。

### 1.4 服务消费（全部走 `ctx.get`，全部可选）【实证】

| 服务 | 取用位置 | 用途 | 缺失时行为 |
|---|---|---|---|
| `sessions` | `lib/client.js:34`、`3343` | 刷新父会话投影（子会话目录）、`subagentAddress` | 降级为 `legacy` 或 toast 失败 |
| `uiWorkspace` | `lib/client.js:40`、`3344` | `openSession(address)` 跳会话（DSH 0.2.x 导航 owner） | 回退 `sessions.open(id)` |
| `workspaces` | `lib/client.js:2542`、`3345` | 「工作目录」下拉（`list.getSnapshot().items`） | 保持默认（空） |
| `agents` | `lib/client.js:2514`、`2561` | 读当前会话模型/provider 作表单默认值；探测有无活跃会话 | 返回空默认 |
| `betterSidebar` | `lib/client.js:3876` | 文件预览优先开右侧栏 `openTab({type:'editor'})` | 回退内联预览 `openPreview()` |

设计亮点：`getClientService()`（`lib/client.js:26-31`）每次动态重取、**不缓存 null**，规避「apply 早于服务注册」的时序问题（注释 `lib/client.js:32-43`）【实证】。

### 1.5 slot / 扩展点真相【实证】

| 搜索项 | 命中 | 结论 |
|---|---|---|
| `ctx.slots` / `register` / `sidebar.footer.action` / `conversation.view` | 0 处调用 | 全部为历史注释 |
| `slot`（标识符） | 仅 `incomingPortSlot` / `flowPorts(slot…)`（`289`、`298`） | 是**连线端口槽位**，与 UI 插槽无关 |
| `betterSidebar` | 仅 `3876` 一处 `openTab` | 单向消费，不注册 |

`lib/client.js:2457-2463` 仍保留一段「插件入口：1) 左侧栏底部 sidebar.footer.action…2) 右侧栏 better-sidebar 两个 tab…」的**过期注释块**，与实现完全不符 —— 这是逆向时最容易误判的一处【实证】。

### 1.6 唯一的 UI 注册点：左侧栏 DOM 入口【实证】`lib/client.js:3266-3340`

| 要素 | 值 / 行号 |
|---|---|
| 属性标记 | `data-dsh-knj-workflow-entry`（`3270`）、`data-dsh-plugin="knj-workflow"`、`data-dsh-part="sidebar-entry"`（`3279-3280`） |
| 文案 | `aria-label="流程设计"`、`title="打开流程设计看板（流程运行 / 流程设计）"`、内部 `<span>流程设计</span>`（`3282-3284`） |
| 样式类 | `className="knj-newtask"`（`3281`），CSS 刻意「与原生设置触发按钮逐属性对齐」（`lib/client.js:500-504`） |
| 插入算法 | 找 `[data-pane="sidebar"], [class*="sidebarCol"]` → `[class*="logoRow"]` 父元素 → 取新会话按钮 → 在 `[data-dsh-taskboard-entry]` family 之后插入（`3288-3315`） |
| 自愈 | **双 MutationObserver**：body 级（subtree）兜底 shell 重建 + root 级同帧重插（`3331-3337`） |
| 幂等 | 已存在同属性节点则不再挂载（`3275`）；cleanup 断开两个 observer 并移除节点（`3339`） |

> 这等价于 «DSH 侧边栏没有外部 slot，所以复刻 task-board / skill-explorer 的 sidebar-entry-core 逻辑»（注释 `3266-3268`）。代价：强耦合 DSH shell 的 DOM 结构与 CSS Module 类名（`data-pane`、`sidebarCol`、`logoRow`、`newSession`）【推断：DSH 改版即失效】。

---

## 2. UI 结构树

### 2.1 四个挂载根【实证】`lib/client.js:2489-2501、3238-3262、3271-3340、3451-3527`

| 根 | 创建位置 | 挂载方式 | 容器 |
|---|---|---|---|
| A. 左侧栏入口按钮 | `mountWorkflowEntry()` `3271-3340` | 纯 DOM `innerHTML` + `addEventListener`，无 React | DSH sidebar 内 |
| B. 主区看板 | `openDevBoard()` `3238-3262` | `createRoot` 渲染 `WorkbenchView` | 注入中栏 `[data-pane="conversation"]` 或 `[class*="centerCol"]`：`div[data-dsh-knj-board-view]`（`3245-3250`） |
| C. 新建任务模态 | `openNewTaskModal()` `2489-2501` | `createRoot` 渲染 `NewTaskModal`，挂 `document.body` | 独立 overlay |
| D. 图编辑器 / AI 对话坞 | 由 B 内的「流程设计」tab → `SidebarWorkflowsTab.editing` → `GraphEditor`（`3485-3491`） | React 子树（**不是**独立 root） | 看板主区 |

**主区接管手法**（最激进的一处）【实证】：
```
openDevBoard():  3251-3257 关闭时真正 unmount（不是 display:none），避免残留详情/分页/滚动位置
CSS:             625  html[data-dsh-knj-board] [data-pane="conversation"]{display:none!important}
                 626  html[data-dsh-knj-board] [class*="centerCol"]>*:not([data-dsh-knj-board-view]){display:none!important}
```
即：给 `<html>` 打属性 → 用 `!important` 隐藏原生会话子树（保留 DOM 保活）→ 自己的容器插入其中。属「寄生式主区接管」，与 DSH 原生布局强耦合【推断：脆弱点】。

### 2.2 组件树（当前 live 路径）【实证】

```
apply()                                   3342
├─ mountWorkflowEntry()                   3271   → <button.knj-newtask>「流程设计」
│                      click → openDevBoard() 3259
└─ window 'dsh-knj-workflow:open-task'    3358 → openScheduledWorkflowTask() 730
                                                 └─ openDevBoard()+openTaskDetail()

openDevBoard() 3238
└─ WorkbenchView                           3114
   ├─ head: 返回会话 / 流程运行|流程设计 / 表格|看板 / 搜索框      3159-3170
   ├─ tab=tasks → 表格 TableView           3050   (默认 view='table'，3117)
   │             或 看板 KanbanView        2963   (5 列 + 拖拽)
   │       └─ 「新建任务」→ openNewTaskModal() 3204
   │              └─ NewTaskModal          2505   (独立 root, 2489-2501)
   ├─ tab=workflows → SidebarWorkflowsTab  3451
   │       ├─ 列表（分页 8/页）                  3481-3526
   │       └─ editing → GraphEditor        1004
   │              ├─ head 工具条                  1610-1629
   │              ├─ renderInputsPanel()(可选)    1582
   │              ├─ body 4 列: 调色板|画布|resizer|属性面板 1631-1650
   │              ├─ renderAssistDock()           1405  (AI 对话坞)
   │              ├─ renderGuideModal()           1658
   │              └─ renderNodeGuideModal()       1712
   ├─ showArchive → 归档列表                     3179-3197
   └─ detail → overlay(760px) → SidebarTaskDetail 3216-3227 / 3531
            ├─ 需求描述(折叠) 4099     ├─ 任务输入参数 4069
            ├─ 人工审批卡 4002        ├─ 流程进度: 流程图 renderRunCanvas() 3666
            │                                        / 列表 renderNodeCard() 3776
            ├─ 结果字段 3827 / 文件 3850 / 文件预览 3893
            └─ 操作: start/cancel/resume/rerun-stage/decide  4205-4240
```

### 2.3 「每个界面由哪个函数渲染」对照表【实证】

| 界面 | 渲染函数 | 行号 | 局部状态 |
|---|---|---|---|
| 左侧栏入口 | `mountWorkflowEntry()`（DOM 字符串） | `3271-3340` | `workflowEntryDisposer` 模块级 |
| 主看板骨架/页签/搜索 | `WorkbenchView.render()` | `3157-3229` | `tab/view/tasks/workflows/archived/search/searchHits/showArchive/detail` |
| 看板 5 列 | `KanbanView.render()` + `.card()` | `2965-3018` | `dragId/dragOver/confirmId` |
| 表格 | `TableView.render()` | `3052-3100` | `sort/page` |
| 归档 | `WorkbenchView.render()`（inline） | `3179-3197` | `showArchive` |
| 新建任务表单 | `NewTaskModal.render()` + `renderRequirementInput` / `renderAttachments` / `renderTaskInputs` / `renderFullEditor` | `2826-2881` / `2739-2761` / `2693-2737` / `2788-2825` / `2763-2785` | 见 `2508` |
| 工作流列表 | `SidebarWorkflowsTab.render()` | `3479-3527` | `workflows/editing/page` |
| 画布 | `GraphEditor.renderSvg()` + `renderNode` / `renderEdge` / `renderHumanEdge` / `renderLinking` | `1857-2027` | `wf/drag/linking/zoom/panning/selectedId/selectedEdge/assistChanged` |
| 属性面板 | `renderNodeProps` / `renderEdgeProps` / `renderHumanEdgeProps` | `2229-2271` / `2028-2065` / `2067-2100` | 由 `selectedId/selectedEdge` 驱动 |
| 输入参数声明 | `renderInputsPanel()` | `1582-1604` | `inputsOpen` |
| AI 对话坞 | `renderAssistDock()` + `renderAssistMessage()` | `1405-1472` / `1474-1564` | `assistOpen/assistMessages/assistInput/assistBusy/assistError/assistChanged` |
| 任务详情 | `SidebarTaskDetail.render()` | `4125-4190` | `results/rejectFeedback/expanded/fileView/preview/viewMode/graphSel/graphZoom/fitW/reqOpen` |
| 运行流程图 | `renderRunCanvas()` + `runSvgNode()` + `renderGraphDetail()` | `3666-3727` / `3729-3774` / `3595-3636` | `graphSel/graphZoom/fitW` |
| 节点卡片（列表模式） | `renderNodeCard()` | `3776-3825` | `expanded/fileView` |
| 人工审批卡 | `renderHumanCard()` + `renderPreviewPanel()` | `4002-4067` / `3960-3994` | `rejectFeedback/preview` |
| 配置文件预览 | `renderMarkdown()` | `3913-3951` | 无（纯函数式） |

### 2.4 遗留/死代码 UI（重要）【实证】

| 死代码 | 行号 | 判定依据 |
|---|---|---|
| `openOverlay()` | `717-728` | **零调用点**（全仓 grep 仅定义处） |
| `Overlay` 类 | `741-780` | 仅被 `openOverlay` 引用 → 级联不可达 |
| `TasksView` | `782-845` | 仅被 `Overlay.render` 引用（`774`） |
| `TaskDetail` | `847-901` | 仅被 `TasksView` 引用（`791`），且是唯一渲染横向步骤条 `.knj-steps` 的组件（`861-878`） |
| `WorkflowsView` | `903-949` | 仅被 `Overlay.render` 引用（`775`） |
| `SidebarTasksTab` | `3367-3448` | 无任何实例化点；测试注释直接承认「SidebarTasksTab 是遗留死代码」`lib/ui-regression.test.js:60` |
| `.knj-step*` CSS | `459-467` | 仅服务已死的 `TaskDetail` |

代价：约 **300 行**死 UI + 相关 CSS 常驻产物；同时 `ui-regression.test.js:38-41` 仍在断言「旧 Overlay 两个页签命名」，使死代码被测试**锁死而无法删除**。
（`overlayRoot/overlayRef/ensureStyle` 非死：`ensureStyle()` 仍被 `openNewTaskModal`（`2490`）、`openDevBoard`（`3239`）、`apply`（`3347`）使用。）

---

## 3. 状态与数据流

### 3.1 状态容器：没有 store【实证】

- **组件内**：全部 `this.state`（12 个 class 组件，见 `react.Component` 计数）；跨组件靠 props 回调（`onChanged` / `onBack` / `onOpenDetail` / `onSaved`）。
- **模块级单例**（最脆弱的一层）：

| 变量 | 行号 | 作用 | 风险 |
|---|---|---|---|
| `_sessions / _uiWorkspace / _workspaces / _ctx` | `19-24` | 服务缓存 | 多实例/热更后脏引用【推断】 |
| `overlayRoot / overlayStyle / overlayRef` | `705-709` | 遗留 Overlay | 死代码 |
| `newTaskRoot / newTaskRootHandle` | `2487-2488` | 新建任务模态单例 | 重复 open 只 `display:flex`（`2491`） |
| `devBoardRoot / devBoardRef / devBoardRootHandle / _closeDevBoard / pendingScheduledWorkflowTask` | `3232-3236` | 主看板单例 + 调度直达任务暂存 | 无并发/竞态保护 |

- **状态表**：三套并存的状态元数据 —— 任务级 `STATUS_META`（`131-137`）、阶段级 `STAGE_META`（`230-236`）、运行效果图 `RUN_STATUS`（`238-246`，7 态含 `waiting/passed`）。
- **派生状态**：`knjDeriveRunStates(task)`（`249-281`）把任务实例推导成 `{nodeId: status}`（start/end/gateway/human 的补全规则都在此），注释自认「镜像 graph.js deriveRunGraphStates，两处需同步修改」（`247-248`）。

### 3.2 `api()` 封装【实证】`lib/client.js:119-129`

```js
const PREFIX = '/devtask';                    // client.js:16
fetch(`${PREFIX}${path}`, { credentials:'same-origin',
  headers:{'content-type':'application/json'},
  body: JSON.stringify(opts.body) })          // 自动序列化
→ res.json().catch(()=>({}))                  // 非 JSON 容错
→ !res.ok 抛 Error(data.error || `HTTP ${status}`)
```
- 无超时、无重试、无 AbortController、无并发去重（`/assist/progress` 的自定义重试在调用侧，`1320-1331`）。
- 前缀与 Host 一致：`cordis.patch.yml:18` 的 `httpPrefix: /devtask`【实证】。

### 3.3 `/devtask/*` 调用点全量表（23 个端点，按用户交互归组）【实证】

| # | 方法 | 路径 | 调用行 | 触发交互 | 期望返回（客户端消费的字段） |
|---|---|---|---|---|---|
| 1 | GET | `/tasks` | `753`、`3148`、`3376` | 看板 3s 轮询 / 遗留 Overlay / 遗留侧栏 | `{tasks:[]}` |
| 2 | GET | `/tasks?q=<kw>` | `3137` | 看板搜索框（防抖 300ms） | `{tasks:[]}` |
| 3 | GET | `/tasks?archived=1` | `3148` | 看板轮询（归档计数/列表） | `{tasks:[]}` |
| 4 | POST | `/tasks` | `816`、`2918` | 新建任务提交 | 无（成功即 toast） |
| 5 | GET | `/tasks/:id` | `733`、`842`、`3155`、`3445` | 调度直达 / 点卡片开详情 | `{task}` |
| 6 | DELETE | `/tasks/:id` | `3045`、`3109`、`3439` | 删除任务（`window.confirm` 后） | 无 |
| 7 | POST | `/tasks/:id/start` | `4229` | 详情「启动」（pending） | 无 |
| 8 | POST | `/tasks/:id/cancel` | `4236` | 详情「取消」（running） | 无 |
| 9 | POST | `/tasks/:id/resume` | `836`、`896`、`3038`、`3105`、`4222` | 续跑（`body.mode = resume\|rerun`，`4222`） | 无 |
| 10 | POST | `/tasks/:id/rerun-stage` | `889`、`4215` | 单阶段重跑 `{stageId}` | 无 |
| 11 | POST | `/tasks/:id/decide` | `4208` | 人工审批选去向 `{decision, feedback?}` | 无 |
| 12 | POST | `/tasks/:id/archive` | `3041`、`3106` | 卡片/表格「归档」 | 无 |
| 13 | POST | `/tasks/:id/restore` | `3194` | 归档列表「恢复」 | 无 |
| 14 | GET | `/tasks/:id/results` | `3546` | 详情挂载拉产物 | `{results:{[stageId]:object}}` |
| 15 | GET | `/tasks/:id/stages/:stageId` | `3569`、`3588` | 展开节点补产物（results.json 缺失兜底） | `{data:object}` |
| 16 | GET | `/tasks/:id/file?path=<rel>` | `3865`、`3908` | 查看文件 / 审批预览 / 目录浏览 | `{path,isDir,entries,content,meta,tooLarge}` |
| 17 | GET | `/workflows` | `753`、`2570`、`3148`、`3460` | 轮询 / 新建表单 / 工作流列表 | `{workflows:[]}` |
| 18 | POST | `/workflows` | `1216` | 图编辑器「保存」（body = `buildGraph()` 规范化结果） | 无（成功后重置 undo 基线） |
| 19 | DELETE | `/workflows/:id` | `945`、`3515` | 删除工作流（confirm 后） | 无 |
| 20 | GET | `/models` | `2526` | 新建表单「执行模型」下拉 | `{models:[{provider,model}]}` |
| 21 | POST | `/uploads` | `2619`、`2674` | 文件入参 / 附件上传 | `{uploadId,name,size}` |
| 22 | POST | `/assist` | `1285` | AI 对话发一轮 | `{requestId}` |
| 23 | GET | `/assist/progress?id=&since=` | `1319` | AI 过程轮询（700ms） | `{events:[{seq,kind,text}],stream?,done?,error?,result?}` |

**POST `/tasks` 的 body 组成**（`lib/client.js:2898-2917`）【实证】：
`{ workflowId, description?, storyCode?, cwd?, model?, provider?, inputs?:{文本参数}, fileInputs?:{[name]:{uploadId,name}}, attachments?:[{uploadId,name}] }`
—— 注意**不提交 title**：标题由 Host 依需求派生（注释 `2896-2897`）。

### 3.4 轮询 / 定时器 / 刷新策略【实证】

| 位置 | 周期 | 目的 | 清理 |
|---|---|---|---|
| `WorkbenchView.componentDidMount` `3119` | **3000ms** | `/tasks` + `/workflows` + `/tasks?archived=1` 三并发（`3148`） | `componentWillUnmount` `clearInterval` `3120` |
| `Overlay.startPolling` `747`（死码） | 3000ms | `/tasks`+`/workflows` | 关闭面板时 `stopPolling` `769` |
| `SidebarTasksTab` `3372`（死码） | 3000ms | `/tasks` | `3373` |
| `pollAssist` `1302-1381` | **700ms** | `/assist/progress` 增量拉取 | `_assistCancelled`（卸载置位 `1030`） |
| 搜索防抖 `3125-3131` | 300ms | 输入停 300ms 才查 Host | `clearTimeout` `3128` |
| 撤销态输入提交 `1057-1063` | 600ms | 连续输入合并为 1 个 undo 步 | `flushPending` 立即提交 `1065-1071` |
| toast 自动消失 `702` | 2000ms | — | — |
| 操作后延迟刷新 `4210/4217/4224/4231/4238` | 500ms | 等 Host 状态落库再拉详情 | — |
| workspaces 刷新竞速 `2544-2547` | 3s 上限 | `Promise.race` 防 `ws.refresh()` 挂起卡表单 | — |
| assist 轮询失败重试 `1320-1331` | >10 次放弃 | 网络抖动不把 UI 卡在 busy | — |

> 关键设计：看板关闭时**真正 unmount**（`3251-3257`）而不是隐藏，从而停掉 3s 轮询；注释明确批评过「display:none 导致隐藏面板仍每 3s 打请求」（`707-709`）【实证】。

### 3.5 进度条如何按阶段状态更新【实证】

```
progressPct(t)  client.js:2408-2416
  steps = t.stageStates || []            // 阶段列表
  status==='success' → 100
  relevant = steps.filter(s=>s.status!=='skipped')   // 跳过阶段不计分母
  → round(done/relevant*100)
```
- 渲染点：看板卡（`3009`）、表格（`3081`）、遗留侧栏（`3425`）、详情（`4145-4148`）。
- 运行中额外动画：`.knj-progress.animated`（`4145`）+ CSS `knjBarStrip`（`686`、`694`）。
- 代码分步文案 `boardStageText()`（`2950-2960`）与 `SidebarTasksTab.stageInfo()`（`3380-3390`）**逐字重复**（见 §7.2）。

### 3.6 事件驱动入口【实证】

| 事件/通道 | 行号 | 用途 | 派发方 |
|---|---|---|---|
| `window.addEventListener('dsh-knj-workflow:open-task')` | `3353-3360` | 调度器创建任务后直达详情（`detail.taskId`） | **仓库内无派发点**（见 §8-U1） |
| `window.addEventListener('keydown')`（GraphEditor） | `1026`、`1032-1041` | Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z | 本组件 |
| 服务调用 `uiWorkspace.openSession` / `sessions.open` | `70-81` | 跳原生会话 | 本插件 |

---

## 4. 画布 / 图编辑器（GraphEditor）

`class GraphEditor extends react.Component` `lib/client.js:1004-2396` —— **1393 行，占全文件 32%**，单文件内最大单元。

### 4.1 布局与渲染技术【实证】

- 三段式 CSS Grid：`grid-template-columns: 150px 1fr 5px ${propsWidth}px`（`1632`；`propsWidth` 默认 380，`1017`）→ 调色板 / 画布 / 拖拽分隔条 / 属性面板；CSS 基线 `160px 1fr 600px`（`538`）。
- **渲染技术：自研 inline SVG，无 canvas、无第三方图库**【实证】`renderSvg()` `1857-1881`：
  - `<svg width={maxX*zoom} height={maxY*zoom}>` + 网格背景（CSS 双层 linear-gradient，`540`）
  - 箭头用 `defs > marker`（5 色：默认/红/绿/蓝/橙，`1862-1873`）+ **手工三角** `arrowShape()` 兜底（`378-383`，注释说明「绕开 SVG marker 渲染可靠性问题」）
  - 选中边加透明加宽命中区 `strokeWidth:16`（`1913`）；标签用 `<rect>+<text>` 手工排版（`1917-1921`）
- 节点几何：矩形任务/人工 `120×44`、菱形网关半对角 30、胶囊起止 `60×36`（`1968-1983`）；端口 = 节点右侧蓝点，`end` 节点无端口（`2022-2025`）。
- 视图能力：滚轮平移 `startPan/onCanvasMove`（`1818-1823`、`1780-1782`）、缩放 `zoomBy`（0.5–2.0，`1830-1833`）、`home()` 回归（`1824-1829`）、全屏（`536`、`1618`）。
- **坐标换算**：`canvasPoint()` 同时处理 `getBoundingClientRect` + `scrollLeft/Top` + `zoom`（`1835-1840`）——所有命中判定都经过它（`1768`、`1772`、`1795`、`1810`）。

### 4.2 连线路由算法（镜像 Host `graph.js`）【实证】

| 函数 | 行号 | 算法 | 同步声明 |
|---|---|---|---|
| `incomingPortSlot` | `289-296` | 同一目标多入边 → 分配不同槽位（含 human routes 虚拟边） | — |
| `flowPorts` | `298-314` | 按相对角度选左右/上下边，槽位做 ±12px 散布，端点内缩 | — |
| `flowObstacles` | `317-327` | 除端点外的节点卡片 + 留白 → 障碍矩形 | — |
| `routeEdgeKnee` | `331-359` | 直通 2 点 → 竖列 3 段避卡（步长 10px）→ V-H-V 上下包抄（±60..150）→ 兜底中线 | 注释「镜像 graph.js routeEdgeKnee（两处需同步）」`329-330` |
| `smoothCurvePath` | `362-375` | 骨架点 Catmull-Rom → 三次贝塞尔 | 注释「镜像 graph.js」`361` |
| `arrowShape` | `378-383` | 终点画三角 | — |
| `routeEdge` | `387-424` | 先 21 点采样判断直连是否撞卡；不撞→同层 `H` 直线或 S 贝塞尔；撞→knee+样条 | 注释「镜像 graph.js routeEdge」`385-386` |

> **双实现风险**：同一套路由逻辑在 Browser（本文件）与 Host（`lib/graph.js`，队友负责）各写一遍，靠注释「两处需同步」+ 测试（`lib/ui-regression.test.js:155` 断言函数签名）维持一致【推断：漂移高发区】。

### 4.3 拖拽与连线交互【实证】

| 交互 | 实现 | 行号 |
|---|---|---|
| 拖节点 | `startDrag` 记 `{ox,oy}` → `onCanvasMove` 每帧 `patchNode(..., record=false)`（不入 undo）→ `onCanvasUp` 统一 `pushNow` 入栈 | `1258-1262`、`1766-1770`、`1790-1793` |
| 拖拽连线 | `startLink`（端口 mousedown，`stopPropagation`）→ move 时 70×42 命中框找 `hoverId` → up 时 `nodeAt` 命中则 push `{from,to}`（去重）；虚线预览 `renderLinking` | `1264-1268`、`1771-1779`、`1794-1805`、`1882-1889` |
| 平移画布 | 空白 `<rect fill=transparent>` mousedown → `startPan`；`canvas.scrollLeft/Top` | `1875`、`1818-1827` |
| 属性面板宽度 | `resizer` mousedown → 260–700px | `1642`、`1841-1844`、`1783-1786` |
| 环边判定 | `isUpstream(a,b)` DFS → 红色虚线警示 | `1845-1856`、`1902`、`1915` |
| 删除 | 节点（start/end 禁删）、边、人工去向 | `1138-1145`、`2158-2164`、`2108-2116` |

### 4.4 节点面板 / 属性面板【实证】

- **调色板**：4 类可加节点 `task / gateway-xor / gateway-and / human`（`1635`，标签 `NODE_LABEL` `2398`）；`addNode` 注入默认结构（task→`inputs/body{prompt,mode,output}/prehook/posthook`；human→`displayFrom/routes`）（`1124-1137`）。
- **节点属性** `renderNodeProps`（`2229-2271`）：
  - 标题、编码（`onBlur` 提交 `patchNodeId`，联动改所有引用：edges、routes、approveTo/rejectTo、displayFrom、inputs[].from，`1102-1123`）
  - task：行为 prompt（多行 + `${...}` 引用清单，`2247`）、执行方式 single/parallel（`2250`）、`maxRuns` 默认 3 防死循环（`2255`）、输出 schema、prehook/posthook
  - human：displayFrom（节点 id **或文件路径**双模式，`2261`）、多去向行（标签/色调/目标/删除，`renderRouteRow` `2127-2145`）
  - 字段提示用自绘 tooltip（`showTip/hideTip` `2316-2321`，渲染 `1655`）而非浏览器 title。
- **边属性** `renderEdgeProps`（`2028-2065`）：多出边时才要求条件（`needCondition = outCount>1`）；`when = {field, op(eq|neq|in), value}`；`default` 兜底勾选；`valueToText` 双向转换（`2153-2157`）。
- **输出 schema 编辑** `renderOutputSchema`（`2272-2292`）：字段名逗号分隔 + 每字段类型下拉 `string/number/boolean/array/file/dir`（`2301-2309`，`file/dir` 专供审批预览）+ 枚举 + 字段说明。

### 4.5 输入参数声明 UI（工作流级）【实证】

`renderInputsPanel(wf)` `1582-1604`，由头部按钮「输入参数（N）」展开（`1625`）：
- 每行：`name`（名称，`${inputs.名称}` 引用）/ `label`（显示名）/ `type`（`text|file`）/ `required` 复选 / 删除（`1590-1600`）
- 说明文案：「文件类型：新建任务时选文件，工作流只拿到落盘路径 `<工作目录>/.knj-inputs/<任务 id>/`（**不注入文件内容**）」（`1601`）
- 变更走 `setWf({inputs})`（`1584`），**不入 undo**（`setWf` 显式注释「名称/ID 元数据不进 undo」`1094`）【实证：输入参数声明不可 Ctrl+Z】

### 4.6 导入 / 导出（.workflow.json）【实证】

| 动作 | 实现 | 行号 |
|---|---|---|
| 导出 | `buildGraph()` 规范化 → `exportWorkflowFile()` → Blob + `<a download>`（文件名 `<id>.workflow.json`），1s 后回收 objectURL | `1231-1233`、`169-182`、`157-167` |
| 导入解析 | `parseWorkflowFile(text, existingIds)`：容错 `{workflow:{}}` 包装；旧版 `stages` 数组给出明确拒绝；自动补 `start/end` 节点；缺坐标用 `autoLayout` 补齐（防 SVG NaN）；返回 `{ok,wf,conflict,error}` | `189-214` |
| 入口 | 编辑器头部「导入/导出」（`1620-1622`）、工作流列表（`3498`、`3511`）、遗留 Overlay（`930`、`943`） | — |
| 冲突处理 | 同 ID 不阻止，toast 提示「保存将覆盖，可先改 ID」 | `1250-1252`、`3474-3476` |

### 4.7 撤销 / 重做栈【实证】

```
history:      JSON 快照数组（栈顶 = 当前提交态），上限 101 条     1020-1022 / 1046-1047
redoStack:    被撤销的快照                                    1021-1022 / 1075 / 1080-1085
pushHistory:  与栈顶相同则去重；入栈即清空 redo              1043-1050
pushNow:      一次性动作（拖拽结束/增删节点/连线/布局/删去向）→ flushPending 后入栈  1052-1055
scheduleCommit: 文本类连续输入 600ms 防抖，合并为一个动作     1057-1063
flushPending:  撤销/保存前强制提交 pending，保证顺序         1065-1071
undo/redo:     浅恢复快照 + 清空选中                            1072-1086
快捷键:        Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z（焦点在 INPUT/TEXTAREA/SELECT/contentEditable 时不拦截）1032-1041
基线重建:      保存成功、导入成功 → history=[当前]，redo 清空  1221-1223 / 1247-1249
```
- 拖拽坐标**不逐帧入栈**，在 `onCanvasUp` 作为一次动作提交（`1770`、`1792`）【实证】。
- `canUndo/canRedo` 存 state 供按钮 disabled（`1623-1624`）。
- AI 整轮改动 = **一次 undo 步**（`1362-1363`），与手绘步骤不混淆。

### 4.8 保存与规范化【实证】`buildGraph()` `1146-1209`

保存前**在客户端做语义规范化**（这是很容易漏掉的一层）：
1. 节点 `inputs` 过滤掉缺 `from/field` 的半成品（`1152`）；
2. human 节点 `approveTo/rejectTo` → `routes[]` 迁移并删除旧字段（`1154-1163`）；
3. 边 `value` 智能强制转换：`'true'→true`、`'false'→false`、数字串→数字，`${...}` 引用保留字符串（`1171-1178`）——注释解释「UI 输入框存字符串，subagent 输出真值，不转换则 `'true'===true` 永远失配、条件静默走 default」；
4. `op=in` 时字符串 → 逗号数组（`1180-1182`）；空 `when` → `null`（`1186`）；
5. 同 `from->to` 去重合并：两条都有条件**不合并**（交给服务端报重复边），一条有条件一条没有才合并（`1189-1206`）。
保存成功后把**规范化结果回写 state** 并重置 undo 基线（`1218-1223`）。

---

## 5. AI 对话坞（AI Assist Dock）

位于图编辑器下半区（`lib/client.js:1405-1472` 布局、`lib/client.js:1274-1381` 协议驱动），是本插件「最巧妙」的部分：客户端把 Host 的**异步两段式**（启动返回 requestId → 轮询过程）包装成「实时过程流 + 整轮一次撤销」的交互。

### 5.1 布局【实证】

- CSS：`.knj-assist-dock{height:38%;min-height:150px;max-height:60%}`（`548`），收起态 `.collapsed`（`549`）；左侧 `.knj-assist-log`（对话过程，`551`），右侧 `.knj-assist-input`（指令输入，宽 300px，`597`）。
- 左区头部：标题「🤖 AI 助手 · 对话」+ 忙闲指示点（`1435-1443`）+「＋ 新对话」（`1441`）+「收起」（`1442`）。
- 消息流 `.knj-assist-msgs`（`1444`）：空态引导文案（`1424-1427`）→ 逐条 `renderAssistMessage`（`1428`）→ busy 时「助手正在设计改动…」（`1429-1432`）。
- 右区：指令 textarea（Enter 发送 / Shift+Enter 换行，`1448-1453`）、4 个快捷 chip（环线/插入/分支/改写，`1417-1422`、`1454-1459`）、发送按钮 + 提示文案（`1460-1468`）、错误条（`1469`）。
- 头部工具条有开关按钮（`1627`），收起后显示「本轮 AI 改动 N 处（未保存）」（`1411-1413`）。

### 5.2 协议（客户端视角的返回结构）【实证】

```
POST /assist  { workflow, message, history }        client.js:1285
   history = assistHistory(messages, 8)             4281-4286  只取最近 8 条 user/assistant 纯文本
   ← { requestId }                                   1286

GET /assist/progress?id=&since=<lastSeq>             1319
   ← { events:[{seq, kind, text}],                   1333-1337  追加到"过程行"
        stream:{ text, reasoning, tools:[{name,args,result,status}], usage:{inputTokens,outputTokens} },
                                                      1339
        done, error?,                                 1340-1345
        result:{ workflow, reply, applied[], rejected:[{action,reason}], childId, elapsedMs } }
                                                      1346-1376
```
- 客户端**假定**：`events` 按 seq 单调、`since` 可做增量游标（`1334`）；`done` 为终态；`result.workflow` 必须含 `nodes/edges` 数组，否则视为无效并报错（`1348-1352`）。
- 事件 `kind` 的取值集合客户端不解析（只透传到 `steps[].kind`，`1335`）→ **Host 契约细节属未知**（见 §8-U2）。

### 5.3 一轮对话的完整状态机【实证】

```
sendAssist(text)  1274-1296
  ├─ 空/忙 → 直接返回（1276）
  ├─ 取 history（1277）+ before = buildGraph() 快照（1278）
  ├─ push 用户气泡，assistBusy=true（1280-1283）
  ├─ POST /assist → 无 requestId 时抛「请重启 dsh web 以启用过程显示」（1286-1287）
  └─ pollAssist(requestId, before)  1301-1381
       ├─ 先插入一条 pending 助手消息（1305-1307）
       ├─ loop:
       │    ├─ _assistCancelled → return（1316，卸载安全）
       │    ├─ GET progress；失败累计 >10 次 → 标错并结束（1320-1331）
       │    ├─ events → since=最后 seq，steps 累加，patchLast 刷新（1333-1337）
       │    ├─ stream 快照覆盖（1339）
       │    └─ done:
       │         ├─ error → patchLast(error) + 结束（1341-1345）
       │         ├─ 无效 workflow → 报错（1348-1352）
       │         ├─ 缺坐标 → autoLayout 补齐（1353-1359）
       │         ├─ changed = assistDiff(before, next)（1360）
       │         ├─ flushPending + pushHistory(next)  ⇒ 整轮 = 一次 undo 步（1362-1363）
       │         ├─ setState(wf=next, assistChanged=[nodes...,edges...])（1364-1368）
       │         └─ patchLast({content, applied, rejected, childId, elapsedMs})（1369-1376）
       └─ 700ms 间隔（1379）
```

### 5.4 「逐条校验、逐条应用」的真相【实证 + 澄清】

- **校验与应用发生在 Host**：客户端把 `before` 整图发给 `/assist`，拿到的是**已完成校验的最终 workflow**；`applied[]`（生效动作）与 `rejected[{action,reason}]`（被拒动作+原因）只是**展示数据**。
- 客户端不做逐条回放（无 `applyAction()` 之类的函数），只做 3 件事：
  1. 整图替换（`1364-1368`）；
  2. 用 `assistDiff(before, next)`（`4255-4274`）算出「哪些节点/边变了」用于画布高亮 —— **坐标变化不计**（`stripLayout` 剥 `x/y`，`4244-4248`；注释解释「布局归 Client，AI 不写坐标」）；
  3. 渲染动作卡（✓ / ! + 原因，`1539-1559`）。
- 动作 → 人话映射 `describeAssistAction`（`1566-1580`）：`add_node/set_node/remove_node/add_edge/remove_edge/set_edge/set_routes/set_meta`。

### 5.5 高亮与整轮撤销【实证】

- 画布高亮：节点绿虚线外框 + 右上 ✓ 角标（`2008`、`2012-2016`）；边绿虚线（`1910`、`1915-1916`）；颜色 `#16a34a`。
- 动作卡标题栏右侧出现「↶ 撤销本轮」（`1555`）→ `undoAssistTurn()` = `this.undo()` + 清 `assistChanged`（`1394-1397`）。
- 撤销粒度：因为整轮只 push 一次（`1363`），Ctrl+Z 一次即回退整轮；连续多轮各自成步【实证】。
- 注意：`assistChanged` 在保存成功后**不清空**（`1210-1229` 无该字段清理），只有新对话（`1401`）或撤销（`1396`）才清 → 保存后画布仍可能残留绿色高亮【推断：观感瑕疵】。

### 5.6 推理 / 工具 / token 渲染【实证】

| 元素 | 条件 | 行号 |
|---|---|---|
| 💭 思考（reasoning，灰字、限高 130px） | `stream.reasoning` | `1488-1492`；CSS `585-587` |
| 工具卡片（⏳/✓/⚠ + name + args 截 160 + result 截 200） | `stream.tools` 过滤后非空 | `1497-1504`；CSS `588-594` |
| 正文流 + 闪烁光标 | `stream.text`（`m.pending` 时有 caret） | `1506-1510`；CSS `595-596` |
| 过程行（灰点 + 文本，逐条出现，busy 时「进行中…」） | `m.steps` | `1514-1523`；CSS `576-580` |
| **token 用量** `tokens in/out` | **仅当 `m.childId` 存在**时才渲染该块 | `1526-1537`（`1534-1535`） |
| 用时 `elapsedMs` | 同上（同块内） | `1533` |

> 细节：`isStructuredOutputTool()`（`4277-4279`）把 `structured_output` 通道从工具卡片里过滤掉（其内容已作为正文展示）；token 显示被嵌在 `if (m.childId)` 分支内，**没有 childId 时即使有 usage 也不显示**（源码事实）【实证】。

### 5.7 跳转助手完整会话【实证】

- 按钮仅在有 `childId` 时出现（`1526-1532`）→ `viewAssistSession(childId)`（`1383-1392`）→ `openSessionById()`（`70-81`）：优先 `uiWorkspace.openSession(target)`，回退 `sessions.open(id)`；目标地址解析见 `resolveSubagentTarget()`（`52-63`，可从子会话 id 合成 `{parentSessionId,childSessionId,mode:'unknown'}`）。
- 对比：任务详情的「查看会话」走的是更完整的 `jumpToSubagentSession()`（`106-117`）——失败会先 `refreshProjections/refreshSubagents` 刷新父会话目录再重试。**AI 助手路径用的是简化版（不刷新重试）**【实证】。

### 5.8 失败与取消【实证】

| 场景 | 行为 |
|---|---|
| `/assist` 启动失败 | 追加一条 error 助手消息 + `assistError` 显示（`1289-1295`、`1469`） |
| 轮询连续失败 >10 | patchLast 标「过程查询失败」+ 结束 busy（`1322-1327`） |
| 组件卸载 | `_assistCancelled = true` 停止循环（`1030`、`1316`） |
| 上一轮未完成 | 发送按钮/新对话按钮 disabled（`1441`、`1464`、`1400`） |
| 无 requestId | 明确提示重启 dsh web（`1287`） |

---

## 6. 样式体系

### 6.1 注入方式【实证】

- 单个**模板字符串** `const css = \`...\``：`lib/client.js:426-695`（270 行，约 60 条规则组），由 `ensureStyle()` 创建 `<style>` 追加到 `document.head`（`710-716`），幂等靠模块级 `overlayStyle`。
- 类名统一前缀 `knj-`：**144 个不同的 knj-\* 类名**；`data-dsh-*` 属性 6 个（`data-dsh-knj-board[-view]`、`data-dsh-knj-workflow-entry`、`data-dsh-part`、`data-dsh-plugin`、`data-dsh-taskboard-entry`）。
- 布局主要靠 CSS 类，但**组件内部又大量用 inline style**：`style: {` 出现 **270 次**、`react.createElement` **784 次**（无 JSX）→ 同一样式（如 `labelStyle/valueStyle`）在函数内重复声明（`3831-3832`）。

### 6.2 设计令牌使用【实证】

- **35 个不同的 `--dsw-*` 令牌**，共 **372 处 `var(--dsw-*)` —— 且全文件 `var(` 总数也是 372，即 100% 走令牌、零自定义 CSS 变量**。
- 覆盖：颜色（`label-primary/secondary/tertiary`、`bg-base/layer-1/layer-2`、`border-l1/l2/l3`、`fill-2`、`state-*`、`static-*`、`button-primary-*`、`interactive-bg-*`、`bg-mask-2`、`toast-bg`）、圆角/阴影（`shadow-lv2/lv3`）、字体（`--dsw-font-family`）。
- 刻意决策（注释 `431-435`）：弹窗面板**不用** `--dsw-specific-menu`（半透明菜单材质），改用 `bg-layer-1` 实心底 —— 因为模态没有原生 `backdrop-filter: blur(40px)` 会让正文透上来不可读。
- 但 `.knj-pager`（`528`）、`.knj-assist-input`（`597`）、`.knj-board-head`（`628`）**仍使用** `--dsw-specific-menu`（同一半透明材质）→ 与上述决策不一致，压在自研面板上是否可读属未验证视觉风险【推断】。

### 6.3 硬编码色与暗色适配风险【实证】

- **26 个硬编码 hex**（`var(--dsw-*)` 之外），分两类：
  - 语义色板（深浅主题通用，注释 `237` 明说）：`#2f6bff` `#16a34a` `#dc2626` `#d97706` `#7c5cff` `#5b6472` `#8b95a5` 等；
  - **浅色专用底色**：`#eef4ff`（网关填充 `3741`）、`#e7efff`/`#f0faf3`/`#f3efff`（运行图 task/human/running/done 填充 `3748`）、`#f4f1ff`（人工审批卡背景 `4032`）、`#fff`（审批预览容器 `4043`、`4055`）、`#eef0f3`/`#f5f6f8`/`#e2e6ec`（结果字段回退色 `3831-3832`、`3841`）。
  - → **暗色主题下这些区域会保持浅底**（运行流程图、审批卡、预览容器、产物字段标签）【推断：由硬编码 hex 直接推出】。
- **零 `@media`**：全文件 0 处媒体查询、0 处 `prefers-color-scheme`、0 处 `data-theme` 选择器 → 无响应式、无主题分支，完全依赖 DSH 令牌与固定像素（`width:min(1280px,96vw)`、`width:min(760px,94vw)` 等）。
- 动画：3 个 keyframes `knjBlink`（`610`）、`knjRunPulse`/`knjRunBreath`/`knjBarStrip`（`684-686`），只对「运行中」主信号加动效（设计说明 `681-683`）。

### 6.4 可访问性现状【实证】

- 少量 `aria-label/title`（入口按钮 `3282-3283`、部分 tooltip）。
- 大量**非语义交互元素**：卡片标题 `div onClick`（`3004`）、列表标题 `div onClick`（`3509`）、表格行 `tr onClick`（`3075`）、`span role="button" tabIndex=0` 仅一处（`4052`）→ 键盘可达性整体不足【推断】。
- `window.confirm` 4 处（`3044`、`3108`、`3437`、`3514`）+ 自研模态并存，交互语言不统一。

---

## 7. 代码组织与可维护性

### 7.1 单文件的分区（无显式分区注释，靠大函数自然分段；`lib/client.js:1-4293`）

| 区间 | 行数 | 内容 |
|---|---|---|
| `1-118` | 118 | loader 包装、服务缓存、会话跳转适配（`52-117` 为 218 新增） |
| `119-129` | 11 | `api()` fetch 封装 |
| `131-424` | 294 | 常量表（STATUS/ROUTE/STAGE/RUN）+ 工作流导入导出 + 图标 + **连线路由几何 7 函数** |
| `426-695` | 270 | 全量 CSS 字符串 |
| `697-1003` | 307 | toast / `<style>` 注入 / **遗留 Overlay 三件套** / `hasPath` / `autoLayout` |
| `1004-2396` | **1393** | **GraphEditor（含属性面板、帮助弹窗、AI 对话坞逻辑）** |
| `2398-2501` | 104 | NODE_LABEL / BUILTIN_ACTIONS / progressPct / collectFiles / 镜像常量 / 弹窗打开 |
| `2505-2926` | 422 | **NewTaskModal**（含附件诊断、放大编辑） |
| `2929-3230` | 302 | 看板：BOARD_COLUMNS / KanbanView / TableView / WorkbenchView |
| `3232-3364` | 133 | 主区接管 `openDevBoard` + 左侧入口注入 + `apply` |
| `3366-3528` | 163 | SidebarTasksTab（死）+ SidebarWorkflowsTab |
| `3530-4241` | **712** | **SidebarTaskDetail**（审批卡、运行图、文件预览、markdown、操作） |
| `4243-4293` | 51 | stripLayout / assistDiff / assistHistory / exports |

命名规律：几何/路由 `flow*/route*`、AI `assist*`、看板 `board*`、运行图 `runSvg*`、属性面板 `render*Props`、规范化 `buildGraph`。**分区靠行内注释（`/* ===== */` 仅 4 处：`546/624/681`+`2457-2466`），无文件级目录/分区表**。

### 7.2 重复实现清单（可直接量化的技术债）

| # | 重复内容 | 位置 | 说明 |
|---|---|---|---|
| P1 | 阶段进度文案逻辑**逐字重复** | `boardStageText()` `2950-2960` vs `SidebarTasksTab.stageInfo()` `3380-3390` | 死代码拖累 |
| P2 | 进度百分比 4 处调用 + 同算式 | `progressPct` `2408-2416`；调用 `3009/3081/3425/4128` | 单一函数，尚可 |
| P3 | 节点半宽/半高常量 | `flowPorts` `299-300`、`flowObstacles` `322-323`、`halfW()` `1890-1895`、`runSvgNode` `3682` | **4 处**同值不同写法 |
| P4 | 节点类型→颜色映射 | `renderNode` `1962`、`renderRunCanvas` `3683`、`renderHumanEdge`/`marker` `1949` | 3 套 |
| P5 | 连线渲染 | 编辑画布 `renderEdge` `1896-1923` vs 运行画布 inline `3695-3709` | 两套 SVG 生成 |
| P6 | 运行图状态推导 | `knjDeriveRunStates` `249-281` 镜像 Host `graph.js` | 注释自认需同步 |
| P7 | 连线路由 | `routeEdge/routeEdgeKnee/smoothCurvePath/arrowShape` `331-424` 镜像 Host `graph.js` | 注释自认需同步（3 处） |
| P8 | 跨边界常量镜像 | `REQ_INLINE_MAX 8000` `2470`、`FILE_INPUT_MAX_BYTES 32MB` `2473`、`ATTACHMENTS_MAX 20` `2476`、`ATTACHMENTS_INPUT_NAME '附件'` `2479` | 靠测试断言防漂移（`ui-regression.test.js:231-251`） |
| P9 | 任务列表 UI 三套 | `TasksView`（死）、`SidebarTasksTab`（死）、`WorkbenchView`（活） | 同一功能 3 代实现共存 |
| P10 | 工作流列表两套 | `WorkflowsView`（死）vs `SidebarWorkflowsTab`（活） | 同上 |
| P11 | 弹窗外壳 | `.knj-overlay/.knj-panel/.knj-head/.knj-body` 手写 5+ 次（`1663`、`2765`、`2832`、`3021`、`3216`） | 无 `Modal` 组件抽象 |
| P12 | 抓错+toast 模式 | `try{...}catch(e){toast(e.message)}` 约 20 处 | 无统一错误处理 |

### 7.3 可维护性风险清单

| ID | 风险 | 证据 | 等级 |
|---|---|---|---|
| R1 | **God Component**：`GraphEditor` 1393 行 / 约 45 个方法，混合画布、属性编辑、帮助文档、AI 对话、撤销栈、导入导出 | `1004-2396` | 高 |
| R2 | **无构建链，直接改产物**：`lib/` 下即发布物（`files:["lib",...]` `package.json:37-41`）；测试靠正则断言源码文本 | `ui-regression.test.js:9-11`、`:34-36`、`:57` | 高 |
| R3 | **测试与实现文本强耦合**：改一行 UI 文案/结构即红；`exports.__test` 为测试在生产 bundle 里暴露内部函数 | `4288`、`ui-regression.test.js:22-28` | 高 |
| R4 | **DOM/类名强耦合 DSH shell**：`[data-pane="sidebar"|"conversation"]`、`[class*="sidebarCol"|"centerCol"|"logoRow"|"newSession"]`、`[data-dsh-taskboard-entry]`、`html[data-dsh-knj-board] … !important` | `3288-3315`、`3245`、`625-626`、`3308` | 高（DSH 升级即断，靠双 MutationObserver 兜底） |
| R5 | **死代码 ~300+ 行 + 被测试锁死** | `717-728`、`741-949`、`3367-3448`、`459-467`；`ui-regression.test.js:60` 自认 | 中高 |
| R6 | **双实现漂移**（路由几何、状态推导、镜像常量） | `329/361/385/247` 注释；`ui-regression.test.js:146-157`、`:231-251` | 中高 |
| R7 | **模块级可变单例**（4 组 root/ref + 服务缓存），无并发保护；`openDevBoard` 靠 `devBoardRoot` 判存 | `705-709`、`2487-2488`、`3232-3262` | 中 |
| R8 | **暗色主题局部失效**（硬编码浅底 6 色） | `3741`、`3748`、`4032`、`4043`、`4055`、`3831-3832` | 中 |
| R9 | **零响应式**（0 处 @media），固定像素布局在窄容器（小窗）依赖 `min(...)` 兜底 | `435`、`1664`、`2833`、`3217` | 中 |
| R10 | **无错误边界**：12 个 class 组件无 `componentDidCatch`；一次 render 抛错即白屏（注释里记过 `humanRoutes(undefined)` 白屏教训） | `139-142` | 中 |
| R11 | **样式双轨**：270 处 inline style + 60 条 CSS 类，同一样式对象重复声明 | `3831-3832`、`3838-3841` | 中 |
| R12 | **无 abort/timeout**：`api()` 无取消/超时；卸载后仍可能 setState（仅 assist 有 `_assistCancelled` 保护） | `119-129`、`1030` | 中 |
| R13 | **过期文档注释块** 与 README 旧结构误导后来者 | `2457-2463`；`README.md:16,21,28` | 中 |
| R14 | **低级缺陷**：`STATUS_META` 中 `cancelled` 粘在上一行（格式化损坏）；创建成功后 `openDevBoard()` 连续调用两次 | `135`、`2921-2922` | 低（幂等掩盖） |
| R15 | **可访问性/交互一致性**：`div onClick`、`window.confirm` 与自研模态混用、无 i18n（全中文硬编码） | `3004`、`3075`、`3509`、`3044` 等 | 低中 |

### 7.4 值得学习的实现（「巧妙」点）

1. **异步任务 → 过程流**：`POST /assist` 只拿 `requestId`，进程事件走 `since` 游标的增量轮询（`1319`、`1334`），把「一次黑盒 AI 调用」变成可解释的实时过程；失败 >10 次自动放弃避免 UI 卡死（`1323`）。
2. **整轮 = 一次撤销步**：AI 应用结果前后用 `flushPending + pushHistory`（`1362-1363`），并靠 `assistDiff` 剔除坐标差异（`4244-4274`），使「AI 的改动」与「手绘动作」在撤销栈里粒度可比。
3. **DOM 自愈入口**：双 MutationObserver + 幂等属性标记（`3275`、`3331-3337`），在无 slot 的宿主里把外部注入做到近似稳定。
4. **保存即规范化**：`buildGraph()` 的边值强转/去重/迁移（`1146-1209`），把脏数据的治理放在「写入口」而非渲染处。
5. **输入防抖 + 撤销语义**：文本 600ms 合并（`1057-1063`）、一次性动作立即入栈、撤销前 `flushPending`（`1065-1071`）——撤销顺序不会错乱。
6. **UI 内建排障**：附件上传失败时把 `attachDiag` 直接渲染到界面上（可截图报障），并记录了「FileList 活引用被清空导致静默失败」的实机教训（`2641-2687`、`2731-2735`）。
7. **服务晚注册防御**：`getClientService` 动态重取不缓存 null（`26-43`），解决 Cordis apply 时序问题。

---

## 8. 未解之谜（本仓库内无法判定）

| ID | 问题 | 已知线索 | 状态 |
|---|---|---|---|
| U1 | `dsh-knj-workflow:open-task` 由谁派发？ | 仅 `3358` 监听 + 测试断言存在（`ui-regression.test.js:23`），全仓无 `dispatchEvent` | 【未知】推断为外部调度插件（如 dsh-knj-scheduler）或宿主注入脚本 |
| U2 | `/assist/progress` 的 `events[].kind` 取值范围、`stream.usage` 字段语义、requestId 生命周期与清理 | 客户端只透传 `kind`（`1335`）；从不显式 cancel 请求，卸载仅停轮询（`1030`） | 【未知】需 Host 侧（`lib/index.js` / assist-route）确认 |
| U3 | DSH 0.3 下会话跳转是否仍走 `uiWorkspace.openSession` | 已做 0.1/0.2 双版本适配（`52-117`） | 【未知】`package.json:15` 声明 `<0.3.0-0` |
| U4 | 死代码是否被外部（其他插件/用户书签）通过 window 调用 | 本插件未对 `window` 暴露任何函数（除 `__ModuleLoader__` 与事件监听）；`openOverlay` 无调用点 | 【推断】完全不可达；保留或因测试断言（`ui-regression.test.js:38-41`） |
| U5 | 主区接管后原生会话是否真的保活（滚动位置/输入框内容） | 仅 `display:none`（`625-626`），关闭看板时自己的 root 被 unmount（`3251-3257`） | 【推断】会话子树保活；看板每次重开重新拉数据 |
| U6 | HMR/重复加载时 `<style>` 是否重复注入 | `ensureStyle` 幂等只在模块闭包内有效（`710-716`）；DSH 会按 factory 认领带 `data-plugin-css` 的 `<style>`（`dsh-client-modules` manifest），而此处的 `<style>` 未打标记 | 【未知】可能双重注入 |
| U7 | 运行图 `fitW` 只在首次挂载测量（`3720`），容器宽度变化后不重算 | `if (el && this.state.fitW == null)` | 【推断】缩放「适应」会滞后于容器尺寸变化 |
| U8 | `knjDeriveRunStates` 与 Host `graph.js deriveRunGraphStates` 是否真的等价 | 注释自认「两处需同步」，但无交叉测试直接比对两边输出 | 【未知】由队友 B 核对 |

---

## 附录 A：一句话总览（给报告读者）

> `client.js` 是一个 **4293 行、零构建、零 dsh-client-\* 运行时依赖的 factory-form bundle**：用 «左侧栏 DOM 入口 + 主区寄生接管 + 自建 React root» 三种非官方手段把「任务看板 / 工作流编辑器 / AI 对话改图」塞进 DSH Web；核心资产是 **1393 行的 GraphEditor**（inline SVG 自绘 + 与 Host 镜像的连线路由 + 手写撤销栈）与 **AI 对话坞的 requestId+增量轮询**（把黑盒 AI 变成实时过程流、整轮一次撤销）；最大可维护性风险是 **God Component + 死代码 + 与 DSH shell 的 DOM/类名强耦合 + 双实现漂移**。
