# 开发视角：`dsh-knj-workflow` 的工程现实

> 调查对象：`D:\dsh-knj\dsh-knj-workflow`（插件版本 `2026.10.218`，`type: module`，无构建）
> 调查方式：只读源码 + 实跑测试/复现脚本 + 解包三个历史 tgz 做哈希对账。
> 证据分级：**[实证]** = 我亲自跑过/哈希过/读到的原文；**[推断]** = 由产物反推、可反驳；**[未知]** = 本机无法验证。
> 所有行号取自当前工作区文件（改动前请以 `git diff` 复核，本仓工作区与 git HEAD 已不一致）。

---

## 0. 结论摘要（给报告用的 5 句话）

1. **测试体系是真实可跑的**：23 个 `node:test` 文件、6982 行、389 个用例，一条命令 **389/389 全绿、3.85 秒**（[实证]，Node v24.12.0 / Windows）。但**没有 `test` 脚本、没有 CI、没有 lint、没有 lockfile**——绿灯靠人记得敲命令，不靠门禁。
2. **源码直发、零构建**：`lib/*.js` 就是发布物，工作区 37 个 lib 文件与 `2026.10.218.tgz` 与 `~/.dsh/profiles/web/node_modules/dsh-knj-workflow` **三方逐字节相同（40/40 文件）**（[实证]）。所谓“构建”只剩手改 `package.json` 版本号 + `pnpm pack`。
3. **版本号不是 semver**：`2026.MM.<自增发布序号>`，一个月内单调递增（8.251 > 31 天 → 排除“日”；216→217 只改了 1 行 CSS 就 +1）（[推断]，证据见 §4.2）。
4. **git 不是发版主源，只是滞后快照**：HEAD 停在 `2026.9.192`，工作区已是 `2026.10.218` 且有 7 个文件未提交；216/217/218 三个版本在 git 里完全不存在。历史上出现过 `sync: lib/client.js (2026.8.251)` 这类“逐文件同步”提交 → 主开发在别处（[实证] git log + diff）。
5. **最大工程债是“重复实现 + 手工同步”**：`humanRoutes` 有 4 份拷贝、`nextNode/matchCondition/looseEq/findJoin` 在 `graph.js` 与 `orchestrator.js` 各一份（注释靠“勿偏离”约束）、`deriveRunGraphStates` 在 client 有镜像（注释明写“两处需同步修改”）。测试是唯一把它们钉住的胶水。

---

## 1. 测试怎么跑（可执行证据）

### 1.1 运行方式：`node:test`，无第三方 runner、无 npm script

| 项 | 事实 | 证据 |
|---|---|---|
| 框架 | Node 内置 `node:test` + `node:assert/strict`，**23/23** 文件统一 | [实证] 46 处 import 匹配（`import { test } from 'node:test'` + `import assert from 'node:assert/strict'`） |
| 配置 | **无**。没有 `test` 脚本、没有 `node --test` 配置、没有 jest/vitest/mocha | [实证] `package.json:61-63` 只有 `"pack": "pnpm pack"`；根目录无 `*.lock`/`tsconfig*`/`eslint*`/`.github/`（glob 全空） |
| 文件内约定 | 测试文件头部注释自带运行命令：`运行：node --test lib/<name>.test.js` | [实证] **22/23** 文件都有该行；唯一例外是 `line-endings.test.js`（仓库约束测试，头部是“为什么锁 LF”的说明） |
| 依赖 | 只需 peer 依赖可解析（`index.test.js` 需 `@deepseek-ai/schemastery`） | [实证] 本仓 `node_modules` 是 **junction**，指向 `C:\Users\MrYang\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules`（含 `dsh-agent/dsh-workflow/cordis 4.0.5/schemastery 3.18.5`，实际版本 `0.2.1-rc.2`）；`~/.dsh/profiles/web/node_modules/@deepseek-ai` 下**只有 schemastery**，所以 `index.test.js` 头部“建议在已安装副本目录跑”的注释已过时 |

### 1.2 实跑结果（我跑了，命令与输出均留存）

```powershell
# 正确姿势（Node 24）：把文件列表交给 --test，或让 node 自己展开 glob
node --test 'lib/*.test.js'      # → tests 389 / pass 389 / fail 0 / duration 3850ms   [实证]
node --test $((Get-ChildItem lib -Filter *.test.js).FullName)
                                 # → tests 389 / pass 389 / fail 0 / duration 3932ms   [实证]
```

**⚠️ 陷阱（实测踩到，必须写进接手文档）**：`node --test lib/` 或 `node --test lib` 在 Node 24.12 下**不会**跑测试套件，而是把目录当成一个用例，输出 `✔ lib / tests 1`（[实证]，耗时 0.14s）。谁照着直觉敲 `node --test lib/`，会得到“1 test passed”的假绿。另外 `node --test lib/repro-zero-outedge.mjs` 也会把它当一个“用例”跑（exit 0）。

产物：`reo/tmp/test-all.log`（TAP，2352 行，389 个用例逐条），`reo/tmp/test-run.log`（上面那条错误姿势的现场）。

### 1.3 五种测试手法（不是一个 harness，是五个）

| # | 手法 | 做法 | 用它的文件 |
|---|---|---|---|
| A | **fake ctx + 直驱 handler** | 手搓 `ctx.get(name)` 返回 fake 服务、`store`（内存 task/results）、`bridge`；`registerRoutes(...)` 后取出 `registrations[0].handler`，用 `EventEmitter` 假 `req` + 手写 `res`（`writeHead/end`）驱动路由，断言 `statusCode` 与 `body` | `index.test.js`、`archive.test.js`、`assist-route.test.js`、`file-preview.test.js`、`requirement-routes.test.js`、`repro-decide-order.test.js` |
| B | **vm 沙箱跑源码脚本** | `readFileSync('./orchestrator.js')` → 包成 `(async()=>{...})()` → `vm.runInNewContext`，sandbox 里 mock `args/agent/parallel/phase/log`，用 `agentCalls` 数组断言执行顺序 | `orchestrator.test.js`、`assist-script.test.js`（`repro-*.mjs` 同款） |
| C | **浏览器 bundle 加载** | `client.js` 是 `window.__ModuleLoader__.load({factory})` 的产物：stub `window/document/URL/Blob/react` 后 eval 源码，取 `exports.__test` 里的纯函数断言 | `client.io.test.js`、`client.assist.test.js`、`session-jump.test.js` |
| D | **源码正则结构断言** | 直接 `readFileSync('client.js')` + `assert.match(src, /.../)` 数结构：`ui-regression.test.js` **95 处**、`client.assist.test.js` **47 处**、`session-jump.test.js` **7 处** | 同上（[实证] 计数） |
| E | **真实临时目录 e2e** | `mkdtemp` 建真目录、真 `DevTaskStore`、真 `http.createServer` 收发：`index.test.js` 19 处、`requirement-routes.test.js` 17 处、`uploads.test.js` 4 处、`file-preview.test.js` 3 处、`archive.test.js` 2 处 | [实证] `mkdtemp` 计数 |

另有一个特例：`line-endings.test.js` 测的不是代码而是**仓库约束**——用 `git ls-files --eol` / `git show :<path>` 断言全仓 LF（`line-endings.test.js:1-13` 头部解释原因）。

---

## 2. 逐文件测试地图（23 文件 → 被测对象 → 断言主题）

行数/用例数为实测（`Get-Content` 行数、`test(` 计数，合计 **6982 行 / 389 用例**）。

| # | 测试文件 | 行/用例 | 被测对象（源码锚点） | 关键断言主题 |
|---|---|---|---|---|
| 1 | `archive.test.js` | 162/8 | `index.js` 归档路由 `:2101` `:2109`、列表 `:1743`、`DevTaskStore.listTasks`（`:111` 起） | 归档过滤 `?archived=1`；**缺 `workflowSnapshot` 的历史任务用当前定义兜底并标记 `fallback`**；已有快照不被覆盖；不存在任务的 archive 不 mutate |
| 2 | `assist-edits.test.js` | 283/21 | `assist-edits.js:245 applyEdits`（`precheck` `:74`、`applyOne` `:165`） | AI 编辑动作白名单/语义预检；**孤立节点或 XOR 缺 default → 整批回滚**；`start/end` 不可删；`set_node` 不许写 `x/y/id`；原 workflow 深度不可变 |
| 3 | `assist-prompt.test.js` | 109/10 | `assist-prompt.js:42 summarizeWorkflow`、`:114 buildAssistPrompt` | 摘要含 id/type/title/边条件/human routes；**不泄露 x/y 坐标**（省 token）；规则卡可覆盖；history 角色前缀 |
| 4 | `assist-route.test.js` | 568/26 | `index.js` `WorkflowBridge.runAssist:601`、`startAssist:696`、`assistProgress:1048`、事件采集 `:765-1046`、`POST /assist:1677`、`GET /assist/progress:1692` | 引擎不可用**显式报错**；202 异步 + requestId 轮询；`since` 增量、seq 去重；**done 后注销 `session/event` 监听**；`readSession→readSurface` 逐级降级；全失败也不崩 |
| 5 | `assist-rules.test.js` | 197/12 | `assist-rules.js:164 ASSIST_RULES` × `graph.js:124 validateWorkflow` | **规范条款 ↔ 校验器一致性**（规范自称的每条硬约束都必须真被拦下）；防“规范写错比不写更危险” |
| 6 | `assist-script.test.js` | 71/5 | `assist-script.js`（vm 沙箱） | 透传 `{reply, edits}`；`agent` 返回 null → 显式失败；缺字段容错；输出 schema 限定 |
| 7 | `client.assist.test.js` | 260/25 | `client.js` `__test.assistDiff/assistHistory` + 对话坞源码结构 | 本轮 diff 识别增删改；history 截断 8 条；**整轮改动 = 一次撤销步**；被拒动作显式展示；轮询卸载清计时器 |
| 8 | `client.io.test.js` | 154/10 | `client.js` `__test.parseWorkflowFile/exportWorkflowFile` | 裸对象/`{workflow}` 包装都兼容；旧 `stages[]` 格式给明确提示；缺 start/end 自动补；**缺坐标补数字防 SVG NaN**；同 ID 冲突 |
| 9 | `file-preview.test.js` | 75/2 | `index.js` `GET /tasks/:id/file:2137` | 目录返回单层 `entries`、文件返回 `content`；`..` 越界拒绝 |
| 10 | `graph.test.js` | 590/45 | `graph.js`：`:124 validateWorkflow`、`:309 nextNode`、`:352 resolveInputs`、`:374 prepareWorkflowForSave`、`:397 orderTaskNodesByFlow`、`:445 deriveRunGraphStates`、`:498 routeEdgeKnee`、`:605 routeEdge` | 图校验全规则（start/end 唯一、孤立、重复边、XOR default/死边、**task 多出边同语义**、并行内禁止 human）；路由/数据流；按拓扑而非声明序；运行态推导；**连线正交避让几何**（同层直连/3 段/被堵 V-H-V） |
| 11 | `index.test.js` | 1016/41 | `index.js` `startTask:1075`、`runAssist`、调度器 `:407`、文件入参物化 `:1462/:1486`、需求落盘 `:1532` | 专用 parent 必须 `agentPresets.mount`；**0.2.x engine 被 isolate → `serviceFor` 解析、抛错回落 `scope.get`**；`run.dispose()`；**并发双启动只成功一个（TOCTOU）**；`RunAlreadyActiveError`；必填文件入参缺失拒绝启动；暂存失效拒绝启动；同名加前缀不覆盖；越界名压平；`id` 校验 |
| 12 | `line-endings.test.js` | 78/4 | 仓库本身（`.gitattributes` + git index） | LF 必须锁死；`.gitattributes` 自身也要 LF；工作区与 index 都不得有 CRLF |
| 13 | `monitor-stage-status.test.js` | 125/1 | `index.js` `monitorRun:1238`（agent-start/phase/agent-end 事件 → `stageStates`） | **多轮复用节点：agent-start 必须把上轮 done 置回 running**（否则进度永远显示已完成） |
| 14 | `orchestrator.test.js` | 1032/49 | `orchestrator.js` 全文件（vm） | 串行/XOR/AND split-join/条件宽松匹配（`"5"` vs `5`）；human 暂停与多去向；**顺序双 human 的决策重放**；**驳回回环必须再次暂停同一 human**；`maxRuns` 1/2/默认3；网关互指触发 1000 步上限显式失败；**task 零出边抛错而非静默成功**；checkpoint 上报；file/dir 输出类型归一化 |
| 15 | `repro-decide-order.test.js` | 73/1 | `index.js` `POST /tasks/:id/decide:2030` | **`startTask` 抛 409 时不得把任务改成 running、不得清 humanState**（否则任务永久卡死不可重试） |
| 16 | `repro-paused-runs.test.js` | 112/2 | `index.js` `runs` Map 生命周期 `:1238/:1391` | paused 结束必须清理 `runs`（`isRunning` 为 false）；清理后 `decide` 的 `startTask` 必须成功 |
| 17 | `requirement.test.js` | 116/13 | `requirement.js:13-86` | 阈值 `INLINE_MAX=8000`/`HEAD_MAX=6000`；CRLF/CR→LF、剥 BOM/零宽、折叠空行；标题取首行去 `#`、**按码点截 50 不切代理对**；空需求用时间戳占位 |
| 18 | `requirement-import-ui.test.js` | 593/17 | `client.js` **真实执行** `KanbanView.render()/onDrop`、`NewTaskModal.render()`、`SidebarTaskDetail.renderRequirement/renderTaskInputValues/renderHumanCard`、`selectAttachments/removeAttachment` | 渲染期异常（弹窗一闪即消）；拖失败卡回待执行必须二次确认；**附件换 onChange 必须是快照数组而非活引用**；上传成功必须记 `uploadId`；缺 `workflowSnapshot` 历史任务不得白屏 |
| 19 | `requirement-routes.test.js` | 581/22 | `index.js` `readBody:1556`、`POST /tasks:1755`、`GET /tasks:1734`、`POST /uploads:1718`、`DevTaskStore.listTasks` | **多字节字符跨块不得截成 U+FFFD**；超限 413（**旧实现先 `destroy` 客户端只看到 reset**）；`id="."` 必须拒；列表剥离正文只给字数、`?q=` 命中正文；落盘推迟到启动前（单点 owner = `startTask`）；`/requirement/extract` 已移除=404 |
| 20 | `session-jump.test.js` | 207/16 | `client.js:52-117`（`resolveSubagentTarget/openSessionById/refreshSubagentCatalog/jumpToSubagentSession`）+ 源码接线 | **0.2.x：`uiWorkspace.openSession(subagentAddress)`；0.1.x 回退 `sessions.open`**；`refreshProjections` 优先、`refreshSubagents` 回退、都缺返回 false；首跳失败→刷新投影重试一次；两种都失败抛最后错误 |
| 21 | `ui-regression.test.js` | 285/31 | `client.js` 源码正则（95 处 `assert.match(src)`） | 页签命名「流程运行/流程设计」；列表头计数行与按钮分组；审批卡 file/dir 预览接线；`openSessionById` 接线；需求阈值常量与 Host 镜像；**弹窗 `.knj-panel` 必须不透明**；附件不依赖声明 |
| 22 | `uploads.test.js` | 191/16 | `uploads.js:44 sanitizeFileName`、`:65 UploadStore` | basename 消毒（含 Windows 反斜杠/非法字符/结尾点）；`uploadId` 格式校验才拼路径；32MB 上限；`UPLOAD_BODY_BYTES` 容得下 base64 膨胀 4/3；TTL 清理；跳过非 uploadId 目录 |
| 23 | `workflow-inputs.test.js` | 104/12 | `graph.js:34 validateWorkflowInputs` → `:124` → `:374` | `name` 必须存在/唯一/**禁点号**（`${inputs.a.b}` 无法解析）/禁空白衣路径符；`type` 只 `text|file`，缺省 text（老工作流不受影响）；`required` 归一布尔；并入整体校验 |

> 未进上表但同属测试资产：`lib/repro-ts-review-loop.mjs`（96 行）、`lib/repro-zero-outedge.mjs`（90 行）——**不是 `node:test` 用例**，是“人手跑一次看结论”的确定性复现脚本（见 §3）。

---

## 3. 从测试反推：作者踩过的坑（文件名就是事故档案）

### 3.1 复现脚本的“现状”（我实跑了，这是最有价值的一手结论）

| 脚本 | 期望 | 我实跑的结果 | 判定 |
|---|---|---|---|
| `lib/repro-ts-review-loop.mjs` | 驳回后 `fix`+`submit` 各跑 1 次并**重新暂停在同一 human**；否则 `exit 2` | `exit 0`；`run2: paused=true, pausedAt=human-mttoi2zi, counts={"fix":1,"submit":1}`，输出“符合预期” | **[实证] 已修复**（`decidedMap` + `humanReleased` 语义已落地，`orchestrator.js:38-44`） |
| `lib/repro-zero-outedge.mjs` | task 节点零出边时编排器不得静默判成功 | `exit 0`；两个场景编排器都**抛错**“没有出边（流程在此断头）”，但 **`validateWorkflow` 仍返回 `{"ok":true,"errors":[]}`** | **[实证] 半修**：运行期已拦，**静态校验仍放过**（见 §6 债务 P1-3） |

### 3.2 坑清单（含证据与现状）

| # | 坑（文件名/注释里的现场） | 证据锚点 | 现状 |
|---|---|---|---|
| 1 | **CRLF/LF 漂移**：宿主 `core.autocrlf=true`，工作区 CRLF 而 npm 打包 LF → 每个文件“每行差一字节”，工作区哈希永远无法与安装副本比对 | `line-endings.test.js:1-13`、`.gitattributes:1-15`（注释记录 `lib/index.js: 8589 CRLF vs 8475 LF`） | 已修（`.gitattributes:9` `* text=auto eol=lf`）；[实证] 现在 worktree==tgz218==安装副本 40/40 相同 |
| 2 | **乱码事故（mojibake）**：连“守卫测试”本身都被编码污染，只能重写成英文版 | commit `9d3e1ef fix: replace mojibake-corrupted guard test with clean version`（[实证] git show：只改 `lib/line-endings.test.js`，+31/−39） | 已修；也解释了 `line-endings.test.js` 全文为何是英文 |
| 3 | **paused 后 `runs` 残留**：点驳回后任务卡 running，`resume` 返回 409“任务正在取消/运行中”（现场任务 `task-mtk40fjd`） | `repro-paused-runs.test.js:1-5` 头部 | 已修（测试全绿） |
| 4 | **decide 状态破坏顺序**：先改 `status=running`、清 `humanState` 再 `startTask`；被 409 拒后状态不回滚 → 永久卡死、无法再决策 | `repro-decide-order.test.js:1-9`、修复点 `index.js:2038-2094` | 已修 |
| 5 | **`decidedMap` 二次放行 → 驳回回环空转**：fix/submit 重复执行到 `maxRuns=3` 超限抛错，人工节点永远不再触发（现场 `task-mttp8q71`/`task-mttz5ok7y`） | `repro-ts-review-loop.mjs:1-10`、`orchestrator.js:39-44` `humanReleased` | 已修（§3.1 [实证] exit 0） |
| 6 | **task 零出边静默成功**：“校验通过但 orchestrator 静默判成功 vs graph.nextNode 抛错” | `repro-zero-outedge.mjs:1-3` | 半修（运行期抛错；静态校验仍 `ok:true`） |
| 7 | **多轮复用节点进度卡死**：第二轮 fix 已在第 1 轮 done，`agent-start` 不把阶段置回 running → 显示“已完成 12:06”，实际 checkpoint 12:31 才落盘（`task-mtu18nd3`） | `monitor-stage-status.test.js:1-11` | 已修 |
| 8 | **需求正文跨块被截成 U+FFFD**（中文大文本粘贴） | `requirement-routes.test.js` 首两条用例 | 已修 |
| 9 | **413 先 `req.destroy()` → 客户端只看到 socket hang up**（设计好的 413 永远到不了调用方） | `index.js:1561-1568` 注释、`requirement-routes.test.js`“真实 HTTP 下超限必须收到 413” | 已修 |
| 10 | **task id 路径穿越**：`id="."` 会把文件写到 `tasksDir` 根，污染其它任务目录 | `requirement-routes.test.js`“id=\".\" 必须被拒”；`uploads.test.js:1-10` 注释“本插件栽过一次 task id 路径穿越” | 已修 |
| 11 | **符号链接逃逸**：只查 `startsWith(cwd)` 在盘符根目录失效，可越权读任意文件 | `index.js:2145-2157`（`relative` + `realpath` 双重校验） | 已修 |
| 12 | **0.2.x engine 被 preset isolate**：本机 2026-10-24 报“启动失败：workflowEngine unavailable in the owning agent scope”（引擎其实在，取错口） | `index.test.js:710-746`、`index.js:553-565` | 已修（`serviceFor` → 回落 `scope.get`） |
| 13 | **0.2.x 移除 `sessions.open/refreshSubagents`**：点“查看”报 `refreshSubagents is not a function` | `session-jump.test.js:1-8`、`client.js:66-95` | 已修 |
| 14 | **源码正则测试的盲区**：`ui-regression.test.js` 300+ 断言全绿，却放过“渲染期未定义变量/未绑定标识符”这类真缺陷（实测严重缺陷存活） | `requirement-import-ui.test.js` 头部自述（“实测：严重缺陷能在 300+ 项全绿下存活”） | 已修思路：另起**真执行 render()** 的行为级测试 |
| 15 | **`humanRoutes(undefined)` 白屏**：缺 `workflowSnapshot` 的历史任务打开详情即白屏 | `client.js:139-142` 容错 + `requirement-import-ui.test.js`“缺 workflowSnapshot 必须能渲染” | 已修 |
| 16 | **弹窗材质不可读**：`.knj-panel` 用了菜单材质 `--dsw-specific-menu`（58%/45% 半透明），没有 `backdrop-filter` 就透底盖字 | [实证] 216→217 diff：`client.js` 唯一 5 行改动 + 注释；`ui-regression.test.js` 补“必须不透明表面” | 已修（217 版） |
| 17 | **专用 parent 没挂 agent preset**：workflow subagent 看不到 preset 层 skill/catalog，连 `write`/`bash` 都没有 | `index.test.js:1-9` 头部 | 已修（`setup` 调 `agentPresets.mount` + `meta.agentPreset`） |
| 18 | **僵尸 handler**：HMR/卸载后旧 handler 常驻命令表（引用已卸载 store/bridge） | `index.js:2232-2234`、`:2317-2322` 注释 | 已修（`ctx.effect` 持 disposer） |

**这张表就是“作者的工作方式”**：生产故障 → 先写 `repro-*.mjs` 定性 → 再补成 `node:test` 回归 → 注释里写清现场（任务 id、时间、报错原文）。23 个测试文件里有 4 个文件名直接带 `repro-`/`monitor-`/`line-endings`，全是事故编号。

---

## 4. 构建与发布链路

### 4.1 无构建步骤：源码直发（三方哈希对账）

```powershell
# [实证] worktree 37 个 lib 文件 + 3 个根文件 == tgz 2026.10.218 == 安装副本，40/40 SHA-256 相同
lib same=37 diff=0 missingInInstalled=0
same package.json / same cordis.patch.yml / same README.md
```

- `package.json:37-41` `files: ["lib","cordis.patch.yml","README.md"]`，`main: ./lib/index.js`，`types: ./lib/index.d.ts`，`exports` 三条（`.`/`./client`/`./orchestrator`）。
- **没有** build/prepare/prepack 脚本，**没有** `dist/`、**没有** sourcemap、**没有** TS 编译产物；`client.js` 是**手写维护的浏览器 bundle**（`client.js:1-9` `window.__ModuleLoader__.load({id, factory})`），`ui-regression.test.js` 头注释自述“无构建链、直接维护 lib/ 产物”（[实证]）。
- 副作用：`files: ["lib"]` 把 **23 个 `.test.js` + 2 个 `repro-*.mjs` 一起发上 npm**（tgz 内 40 文件 = 37 lib + 3 根，其中 25 个是用不上的测试资产，约占包体 2/3）。
- 仓库根还躺着 `.dsh-edit-review.json`（**13.9 MB**，已 gitignore 的会话产物）——工作区卫生问题，不是仓库内容。

### 4.2 三个 tgz 的差异（解包到 `reo/tmp/tgz-<ver>/package/`，SHA-256 前 12 位对比）

| 版本 | 文件数 | 与上一版不同的文件 | 实质改动 |
|---|---|---|---|
| `2026.10.216` | 39 | —（基线） | — |
| `2026.10.217` | 39 | `lib/client.js`、`lib/ui-regression.test.js`、`package.json` | **只有 1 行功能性改动**：`.knj-panel` 背景从半透明菜单材质改为 `var(--dsw-alias-bg-layer-1)` + 4 行解释注释（[实证] diff `216→217: 5 insertions, 1 deletion`）；同步补一条 UI 断言 |
| `2026.10.218` | 40 | `lib/client.js`（+106/−22）、`lib/index.js`（**仅 2 行注释**）、`lib/session-jump.test.js`（**新增文件**）、`lib/client.assist.test.js`、`lib/ui-regression.test.js`、`package.json` | **0.2.x 会话跳转适配**：新增 4 个版本适配函数（`openSessionById`/`refreshSubagentCatalog`/`resolveSubagentTarget`/`jumpToSubagentSession`）+ 跳转重试 + 完整测试文件；`index.js` 只更新 `parentSessionId` 的注释（[实证] `217→218 index.js: 2 insertions, 1 deletion`） |
| 三个版本共有 | — | `cordis.patch.yml`、`README.md`、`lib/graph.js`、`lib/orchestrator.js`、`lib/index.d.ts`、其余 18 个测试…… | 完全未变（同哈希） |

> 细节：`216/217` 的 `package.json` **没有文件末尾换行**，`218` 补上了（`\ No newline at end of file` 消失）——也侧面说明版本号是手改 `package.json` 后直接打包。

### 4.3 版本号规则：`2026.MM.<发布序号>`，不是日期、不是 semver

证据链（[实证]，全部来自 git log + 本机安装的 knj 家族）：

| 观测 | 推论 |
|---|---|
| `2026.8.251`（git commit 2026-08-26）——第三位 **251 > 31** | **排除“日/月内日期”** |
| 同月内单调：`2026.9.10` → `.70` → `.72` → `.73` → `.192` → `.193` | 第三位是**单调计数器**，每次发布 +1 |
| `216 → 217` 只改 1 行 CSS 也 +1 | 第三位**不表达语义强度**（不是“patch”） |
| 跨月不重置为 0：`2026.9.193` → `2026.10.216` | 计数器**不在月初归零** |
| 同机 knj 家族：`dsh-knj-prompts 2026.10.150` vs `dsh-knj-workflow 2026.10.218`；`dsh-knj-obsidian 26.10.07` | **每个包各自计数**，不是家族共享计数器（`26.10.07` 是另一个作者的另一种写法） |
| `2026.9.10` 对应 commit `chore: v2026.9.10 统一 knj 家族版本` | 曾有一次“家族对齐”式人工落版 |

**结论**：`<年份>.<月份>.<自增发布序号>`；每月大致几十到两百次递增（9 月 10→193、10 月 216→218），序号可手工跳号。**[未知]**：无法验证 npm 上的真实发布时间与序号对应关系——本机解析 `registry.npmjs.org` 到非公网 IP，`web_fetch` 被拒（记录该限制）。

### 4.4 npm 发布字段审计

| 字段 | 状态 |
|---|---|
| `name`/`version`/`description`/`author`/`license`/`type`/`main`/`types`/`exports`/`files`/`peerDependencies`/`devDependencies` | ✅ 齐备（`package.json:2-60`） |
| `repository`/`homepage` | ✅ `github.com/yangdongzhen590/dsh-knj-workflow`（[实证] 与 `git remote -v` 一致） |
| `engines` | ✅ `node>=20`、**自定义 `dsh: ">=0.1.1-rc.2 <0.3.0-0"`**（非标准字段，靠 DSH 自己解读） |
| `dsh.bundle.patch` / `dsh.client.platform` | ✅ DSH 插件清单字段（`package.json:28-36`） |
| `keywords`/`bugs`/`publishConfig`/`funding` | ❌ 缺（不影响安装，影响市场检索/发布 access 显式化） |
| `scripts.test` / `prepublishOnly` / `prepack` | ❌ 缺 → **发布无任何自动门禁**（测试/校验全靠人记得跑） |
| `tsconfig.json` | ❌ 缺，但 `devDependencies` 里有 `typescript: "5"`（无用依赖）；`lib/index.d.ts` 是**手写的 31 行**，只声明了调度器服务与 `apply/name/inject/Config`，`ctx/store/bridge` 全是 `any`（类型面≈装饰） |

### 4.5 发布流程复原（[推断]，依据 = 上述产物 + 文件时间）

1. 在**另一处工作副本**改 `lib/*.js`（主开发地，不在本仓 git 历史里）；
2. 手改 `package.json` 的 `version`；
3. `pnpm pack` → `dsh-knj-workflow-<version>.tgz`（`scripts.pack` 只有这一条，`package.json:61-63`）；
4. `npm publish`（[未知]，本机不可验证）→ README 宣称包已在 npm（`README.md:65`）；
5. 本地 `dsh plugin --profile web add <tgz>` 安装验证（`cordis.patch.yml:3` 注释里就写着 `dsh plugin --profile web add ./dsh-knj-workflow-2026.9.193.tgz`）；
6. **回头同步 git**：`sync: lib/<file> (<version>)` 逐文件提交，或一次 `chore: sync to released <version> state` 批量提交——**同步是可选的，于是经常滞后**；
7. `.gitignore:2` 忽略 `*.tgz`：**发布归档不进版本库**，根目录三个 tgz 是本地遗留物（`git status` 里看不到它们）。

---

## 5. 版本兼容策略：全部靠“能力探测”，没有一处版本号比较

[实证] 全仓 grep `version|semver|compare` 无版本分支；兼容点只有 `typeof fn === 'function'` 与可选链。`0.1.x`/`0.2.x` 只出现在注释里。

### 5.1 三个实打实的兼容点

| # | 兼容点 | 0.2.x 路径 | 0.1.x 回退 | 锚点/测试 |
|---|---|---|---|---|
| 1 | **workflowEngine 在哪** | `agentPresets.serviceFor(agent,'workflowEngine')`（0.2 的 standard preset 用 `isolate:{workflowEngine:true}` 把引擎关进 delegation 组，根 scope 取不到） | `agent.scope.ctx.get('workflowEngine')`（0.2 之前是宿主 realm 普通服务） | `index.js:542-565`（`resolveWorkflowEngine`）、`missingEngineMessage:567`；测试 `index.test.js:714/:724/:734` |
| 2 | **会话跳转 owner** | `ctx.uiWorkspace.openSession(target)`，target 优先 `sessions.subagentAddress(child)`，目录没就绪则合成 `{mode:'unknown'}` address | `sessions.open(id)` | `client.js:52-117`；测试 `session-jump.test.js` 全文 |
| 3 | **子会话目录刷新** | `sessions.refreshProjections(parentSessionId)` | `sessions.refreshSubagents(parentSessionId)` | `client.js:89-95`；测试 `session-jump.test.js`“0.1.x 回退”条 |

外加两处“可选服务”的降级（不是版本分支，但同属兼容面）：
- `agentPresets` 不存在时 `startTask` 不传 `setup` 也不炸（`index.test.js:700`“无 agentPresets 服务时优雅降级”）；
- `serviceFor` 自身抛错 → 回落 `scope.get`，宿主 API 异常不能把“引擎可用”变成“启动失败”（`index.test.js:734`）。

### 5.2 `cordis.patch.yml` 的兼容策略（这是 0.1.x→0.2.x 最有说服力的证据）

HEAD 版本（0.1.x 时代）：
```yaml
- id: workflow-worker-thread
  disabled: false
- id: tool-workflow
  disabled: false
- insert: [{ id: knj-workflow, name: dsh-knj-workflow, config: { httpPrefix: /devtask } }]
```
工作区版本（0.2.x，现值）：**只剩 `insert` 一条**，注释（`cordis.patch.yml:6-13`）写明：
- `workflow-worker-thread` 这个行 id 在 0.2 **已不存在**，补丁会 `entry not found`；
- `workflowEngine` 自 0.1.x **rc.8** 起就活在 agent-preset 隔离 realm，顶层强行 enable `tool-workflow` 只会让它 `pending (waiting for service: workflowEngine)`；
- 插件改为 `WorkflowBridge.startTask` 从“发起任务的 agent scope”**惰性取引擎**，所以补丁只做插入。

### 5.3 peerDependencies 窗口的演进（[实证] `git diff HEAD -- package.json`）

| 版本 | 窗口写法 | 含义 |
|---|---|---|
| `2026.9.192`（HEAD） | `">=0.1.1-rc.2 <0.1.2-0 \|\| >=0.1.2-rc.1 <0.1.3-0"` | 显式列两个 0.1.x 窗口，**不含 0.2** |
| `2026.10.218`（现状） | `">=0.1.1-rc.2 <0.3.0-0"`（8 个 `@deepseek-ai/*` peer 全一样）+ 新增 `engines.dsh` | 一个窗口同时容下 0.1.x 与 0.2.x |

**推断的兼容姿态**：不追版本号，只追**宿主服务的实际形状**——0.2 改了“取引擎的口”和“会话跳转的 owner”，就加能力探测 + 回退；宿主行 id 消失，就把补丁里的宿主改动删掉（因为引擎现在活在 agent realm，插件不再需要点亮宿主行）。当前工作区实际验证环境是 `@deepseek-ai/dsh-agent 0.2.1-rc.2`（[实证] 本地 junction 里的 peer 版本），也就是说**“兼容 0.1.x”这条已在 216-218 上无法实测**，只有测试里的 mock 守着。

---

## 6. 代码规范与工程债

### 6.1 体量与结构（[实证] 行数）

| 文件 | 行数 | 角色 | 说明 |
|---|---:|---|---|
| `lib/client.js` | **4293** | 浏览器 bundle（React 手写 `createElement`） | 11 个组件类：`Overlay:741 TasksView:782 TaskDetail:847 WorkflowsView:903 GraphEditor:1004 NewTaskModal:2505 KanbanView:2963 TableView:3050 WorkbenchView:3114 SidebarTasksTab:3367 SidebarWorkflowsTab:3451 SidebarTaskDetail:3531`；**无构建、无 JSX** |
| `lib/index.js` | 2338 | Host 插件入口：Store + Bridge + 路由 + 命令 | 单文件塞了 111 行工具层、`DevTaskStore`、`WorkflowBridge`（576-1435）、24 条路由（1598-2188）、命令 |
| `lib/graph.js` | 638 | 纯函数图引擎 | 校验/路由/数据流/运行态推导/**连线几何避让**（同一文件混两类关注点） |
| `lib/orchestrator.js` | 410 | workflow 沙箱脚本（v1 语义复刻） | 见 §6.2 重复实现 |
| 其余 9 个 | 31-285 | 专项小模块 | `index.d.ts` 仅 31 行且 `any` 为主 |
| 测试 23 个 | **6982** | — | 测试/源码 行数比 ≈ **1.35:1**（含注释，质量不低） |

### 6.2 重复实现（最贵的债）

| 重复物 | 拷贝数 | 位置 | 同步方式 |
|---|---|---|---|
| `humanRoutes(node)` | **4** | `graph.js:82`、`orchestrator.js:62`、`client.js:139`、`assist-prompt.js:17` | 无机制；`client.js` 版额外加了 `node` 容错（历史白屏修复），其余三份没有 → **行为已开始分叉** |
| `nextNode`/`matchCondition`/`looseEq`/`findJoin` | **2** | `graph.js:309/:268/:286/:91` vs `orchestrator.js:121/:91/:107/:162` | 头注释约定“与 lib/graph.js 语义一致，**勿偏离**”（`orchestrator.js:18-19`）——靠人读注释 |
| `deriveRunGraphStates` | **2** | `graph.js:445` vs `client.js:247`（注释原话：“镜像 graph.js deriveRunGraphStates，**两处需同步修改**”） | 靠注释 + `graph.test.js`/`ui-regression.test.js` 双份断言 |
| 看板状态文案 `statusText` | **2** | `client.js:2955-2957` 与 `:3385-3387` | 无 |
| `humanRoutesIncomplete` 等 UI 派生 | — | `client.js:152` 起 | 无 |

**为什么不可避免**：`orchestrator.js` 跑在 workflow 引擎沙箱里（**无 fs/network/require**，`orchestrator.js:18-20`），所以不能 `import './graph.js'`——这是“沙箱限制导致的合法重复”，但代价是**图语义有两份实现**，且只有测试能保证不分叉。

### 6.3 静默吞错与可观测性

| 指标 | 数量（[实证] 正则计数） | 评价 |
|---|---:|---|
| `catch {}`（空/仅注释） | `index.js` **26**、`client.js` **10**、`orchestrator.js` 1、`uploads.js` 1、`assist-script.js` 2 | 多数有注释说明“best effort/不影响主流程”，属**故意降级**；但 26 处意味着 Host 侧失败面很宽，出问题只能靠 `dbg` 日志 |
| `dbg(...)` 调用点 | **28**（`index.js`），实现 `:38-44` | 同步 `appendFileSync` 写 `~/.dsh/dev-orchestrator/knj-host-debug.log`，**无轮转、无开关、无级别**——排障时是救命绳，长期是磁盘/性能隐患 |
| 同步 IO | `mkdirSync/readFileSync/existsSync/appendFileSync` 在 `index.js:15` 引入，用于 `dbg` 与少量启动期逻辑 | 热路径（每次状态机转换都 `dbg`）里同步落盘，事件循环上有可见抖动风险 |
| 定时器 | `client.js` 3s 轮询 `setInterval`（`:747/:3119/:3372`，都有 `componentWillUnmount` 清理）；`index.js` assist 采集 2s 兜底轮询（`:835`，done 时 `:741-743` `clearTimeout` + 注销 `session/event`） | 纪律不错；风险点是“新增组件必须自己记得清理”，没有统一 hook |
| TODO/FIXME/HACK | **0**（[实证] 全仓 grep 仅 8 处 `legacy` 相关） | 债**不以 TODO 标记存在**，只活在注释叙述里 → 不可检索、不可统计 |

### 6.4 明确的坑（按严重度）

| 级别 | 债 | 证据 | 影响 |
|---|---|---|---|
| **P0** | 客户端把 API 前缀写死 | `client.js:16 const PREFIX = '/devtask'`；而 Host 侧 `httpPrefix` 可配（`index.js:50` Config、`:2328` 传入、`cordis.patch.yml:13` 明说“可由用户 profile 覆盖”） | 任何改 `httpPrefix` 的部署**整个 UI 全挂**（README 承诺的配置项实际半失效） |
| **P0** | 无门禁：无 `test` 脚本 / 无 CI / 无 lint / 无 lockfile | [实证] `package.json` 只有 `pack`；glob 无 `.github`、`eslint*`、`tsconfig*`、`*.lock` | 389 个用例可以全绿，但没人强制；`node --test lib/` 的假绿陷阱因此格外危险 |
| **P1** | 静态校验放过“task 零出边” | §3.1 实跑：`validateWorkflow → {"ok":true}` | 坏图能保存，只在运行期炸；用户看到的是“任务失败”而不是“保存被拒” |
| **P1** | 图语义双实现 + client 镜像 | §6.2 | 改路由/状态语义必须改 2-4 处，人忘 = 静默漂移 |
| **P1** | UI 测试大量依赖源码正则 | `ui-regression.test.js` 95 处 `assert.match(src)` | 改注释/换行就可能假阴性；且**抓不到运行期缺陷**（坑 #14 已实证） |
| **P2** | 测试资产随包发布 | `files:["lib"]` → tgz 内 25/40 是测试；包 251 KB | 安装体积/信息暴露；`pnpm add` 的用户也会拿到 23 个测试 |
| **P2** | README 与代码漂移 | 缺 8 条已实现路由（`/models:1605`、`/diag:1648`、`/tasks/:id/decide:2030`、`/archive:2101`、`/restore:2109`、`DELETE /tasks/:id:2117`、`/results:2129`、`/file:2137`）；`README.md:5` 指向不存在的 `DESIGN.md`，`:13` 指向不存在的 `design/task-attachments.md` | 新接手的人按 README 找设计文档会扑空 |
| **P2** | 测试文件头部注释过时 | `requirement-routes.test.js` 头部仍写“覆盖 POST /requirement/extract”，而文件末尾用例断言该路由已 404 移除；`index.test.js:231-232` 建议“在安装副本目录跑”（本仓 junction 已可跑） | 误导性文档 |
| **P2** | 单文件巨石 | `client.js` 4293 行无构建 | IDE 卡顿、code review 不可能逐行、合并冲突高发 |
| **P2** | 工作区遗留 | `.dsh-edit-review.json` 13.9 MB、三个 tgz、`reo/`、`.wiki/`、`.doublecheck-report.md` 未清理（均在 gitignore 或未跟踪） | 交接时容易误以为“仓库有脏改动” |

---

## 7. Git 工作流：这个仓库是“同步/发布快照”，不是主开发地

### 7.1 事实（[实证] `git log` / `git remote` / `git diff`）

- 仓库：`github.com/yangdongzhen590/dsh-knj-workflow`，只有 `main` 一个分支（含 `origin/main`），**零 tag、零 PR merge commit**，共 **32 个提交**。
- 提交风格三类，泾渭分明：

| 阶段 | 提交形态 | 例子 |
|---|---|---|
| 2026-08-24 初始 | GitHub 网页式“Add lib/xxx” | `Add lib/index.js`、`Add package.json`、`Initial commit` |
| 2026-08-26 | **逐文件同步**（每文件一条，带版本号） | `sync: lib/client.js (2026.8.251)`、`sync: package.json (2026.8.251)`、`sync: README.md (2026.8.251)` |
| 2026-09 起 | 批量 `chore:`/`wip:`/`fix:`/`docs:` | `wip: archive unpublished local work before syncing to 2026.9.192`、`chore: sync to released 2026.9.192 state; pin LF line endings`、`fix: replace mojibake-corrupted guard test with clean version`、`chore: v2026.9.72 dual compatibility + orchestrator updates` |

- **HEAD = `2026.9.192`，工作区 = `2026.10.218`**：7 个文件已改未提交（`cordis.patch.yml`、`client.js`、`client.assist.test.js`、`index.js`、`index.test.js`、`ui-regression.test.js`、`package.json`），`lib/session-jump.test.js` 完全未跟踪，216/217/218 三个发布版本**在 git 历史里不存在**。
- 头部行数也在变：`HEAD:lib/client.js` 4155 行 → 工作区 4293 行；`HEAD:lib/index.js` 2221 → 2338。

### 7.2 结论

1. **主开发在别处**（另一台机器/另一个工作副本），本仓靠 `sync:`/`chore: sync` 单向灌入；`wip: archive unpublished local work before syncing` 说明连“本仓本地未发布的实验”都要先归档再覆盖。
2. **发布与 git 解耦且滞后**：发版靠 `pnpm pack` + npm，git 同步是事后动作；三次 tgz 都在 `.gitignore` 里（`*.tgz`），**发布归档不可追溯**（只能靠本地残留 tgz）。
3. **没有协作痕迹**：无 PR、无 issue 引用、无 `Co-authored-by`、无 CI 徽章——单人维护。
4. 那条 `fix: replace mojibake-corrupted guard test with clean version` 是**编码治理事故的唯一书证**：Windows 环境下中文注释 + CRLF + 编辑器编码不稳定，最终把守卫测试改成纯英文。

---

## 8. 接手清单：3 个具体改动场景（必改文件 + 必改测试，带行号）

> 通用前置：本地跑测试用
> `node --test 'lib/*.test.js'`（**不要**用 `node --test lib/`，见 §1.2）；
> 依赖已由 `node_modules` junction 提供，**不要** `pnpm add`。

### 场景 A：加一种节点类型（例：`subflow` 子流程节点）

**必改（Host/图语义）**
| 文件:行 | 改什么 |
|---|---|
| `lib/graph.js:16` | `NODE_TYPES` 白名单加新类型（不加 → `validateWorkflow:146` 直接报“type 非法”） |
| `lib/graph.js:124-247` | 在 per-type 循环（`:194-244`）加新类型的度数/拓扑规则；若是路由型节点还要决定是否把它当“虚拟边”计入（`topoEdges:178`、`humanRouteEdges:170` 是 human 的先例） |
| `lib/graph.js:309 nextNode` / `:268 matchCondition` | 若新类型自带多出边路由语义 |
| `lib/graph.js:397 orderTaskNodesByFlow`（`:420` 只收 `type==='task'`） | 新节点是否要进 `stageStates`（决定进度条） |
| `lib/graph.js:445 deriveRunGraphStates`（`:473-486` 分支） | 运行效果图的状态推导 |
| `lib/orchestrator.js:264 executeUntil`（分派点 `:275` task / `:349` gateway-and / `:361` human / `:383` fallback） | **沙箱脚本里必须加一支**；漏了会走 `nextNode` 直通（可能“静默跳过”） |
| `lib/orchestrator.js:62 humanRoutes`/`:71 matchRoute` | 若新类型也是“多去向”语义（注意这是第 2 份 `humanRoutes`） |

**必改（Client/UI，`client.js`）**
| 行 | 改什么 |
|---|---|
| `:2398` `NODE_LABEL` | 显示名（属性面板/新增菜单） |
| `:1635` 新增节点按钮数组 `['task','gateway-xor','gateway-and','human']` | 新类型入口 |
| `:1962` 节点配色表、`:1889-1892/:3682-3683` 尺寸/半宽表、`:1969-2000` 节点 SVG 绘制 | 画布渲染（漏了 → 新节点画不出来/尺寸为 NaN） |
| `:3735-3790` 运行效果图节点绘制 | 运行态图标/配色 |
| `:1130-1160` 属性面板（`if (type === 'human')` 一类分支） | 可编辑字段 |
| `:247-300` **镜像** `deriveRunGraphStates` | 第二份运行态推导（注释已警告“两处需同步”） |

**必改（AI 助手 + 规范）**
| 文件:行 | 改什么 |
|---|---|
| `lib/assist-edits.js:24` `NODE_TYPES` | AI 动作白名单（否则 AI 永远加不出新节点） |
| `lib/assist-edits.js:58 blankNode` | 新类型默认结构 |
| `lib/assist-prompt.js:56` 类型中文名、`:63` human 特判、`:88-113 ASSIST_RULE_CARD`（`:91` 里列举了 add_node 支持的 type） | 规则卡与摘要 |
| `lib/assist-rules.js:20 ASSIST_RULES_SECTIONS` / `:164 ASSIST_RULES` | 规范正文（**必须与 validateWorkflow 一致，否则一致性测试红**） |

**必须同步的测试**
- `lib/graph.test.js` —— `validateWorkflow` 新规则 + `nextNode`/`deriveRunGraphStates`/`orderTaskNodesByFlow` 用例
- `lib/orchestrator.test.js` —— 遍历（含“新节点在并行分支内”等边界）
- `lib/assist-edits.test.js` —— `add_node` 新类型 + 语义预检
- `lib/assist-rules.test.js` —— 规范条款 ↔ 校验器一致性（**新增的硬约束必须补一条“会被拦”的断言**）
- `lib/ui-regression.test.js`（文案/结构）、`lib/requirement-import-ui.test.js`（若碰真执行 render 的抽取区）
- 若新节点参与导入导出：`lib/client.io.test.js`（坐标补齐、旧格式兼容）

> 最容易漏的三处：`assist-edits.js:24` 白名单（AI 静默加不出节点）、`client.js:247` 镜像推导（运行图状态错）、`orchestrator.js:383` 的 fallback 分支（新节点被当普通节点直通）。

### 场景 B：改任务状态机（加/改一个任务状态，或改阶段状态语义）

**必改（Host 状态真源）**
| 文件:行 | 改什么 |
|---|---|
| `lib/index.js:1391 finalizeTask` | 终态映射：`:1396` paused→`waiting-human`；`:1414-1421` `completed→success` / `cancelled→cancelled` / 其它→`failed`；`:1423-1431` 阶段收尾（running→done/failed、未执行的 pending→skipped） |
| `lib/index.js:1238 monitorRun` | 事件 → `stageStates` 的增量更新（agent-start/phase/agent-end；`monitor-stage-status.test.js` 守的就是这条） |
| `lib/index.js:2030 decide` / `:1943 resume` / `:1886 rerun-stage` / `:1855 start` / `:1877 cancel` | 各入口对状态的前置校验与回滚（`:2038` 只允许 `waiting-human`；`:2077-2080` 409 回滚到 `waiting-human`） |
| `lib/index.js:590 isRunning`、`runs` Map（`:1238-1375`） | 并发守卫（`repro-paused-runs` / `repro-decide-order` 守着） |
| `lib/graph.js:445 deriveRunGraphStates`（`:452 waiting-human` 判定、`:473-486`） | 运行效果图映射 |
| `lib/client.js:131-137 STATUS_META`、`:2933-2937` 看板分栏（`statuses:[...]`、`FAILED_KEYS`）、`:2955-2957` 与 `:3385-3387` 两处 statusText、`:834/:859` 徽章、`:2411` 排序权重、`:247-300` 镜像推导 | UI 全部呈现面 |
| `lib/index.js:1743/1755/2129…` 路由载荷 | 若状态值进 API 契约（列表/详情/结果） |

**必须同步的测试**
- `lib/index.test.js`（41 用例，`startTask`/终态/并发守卫都在这里）
- `lib/graph.test.js`（`deriveRunGraphStates` 两条既有用例）
- `lib/archive.test.js`（archive/restore 与状态的关系）
- `lib/repro-decide-order.test.js`、`lib/repro-paused-runs.test.js`、`lib/monitor-stage-status.test.js`（三个“事故回归”必须继续绿）
- `lib/ui-regression.test.js`（文案/徽章/分栏）、`lib/requirement-import-ui.test.js`（真执行 render 的分支）
- `lib/session-jump.test.js` 无关；`client.assist.test.js` 只在碰对话坞时相关

> 状态机是**跨 3 层**的：Host 真源（`finalizeTask`+`monitorRun`）、图推导（`graph.js:445`）、UI 呈现（`client.js` 3 处 + 镜像）。只改一层必然“后台是 success、界面显示 running”。

### 场景 C：加一个 HTTP 路由

**必改（Host）**
| 文件:行 | 改什么 |
|---|---|
| `lib/index.js:1599-2188` | 路由表数组里加一条 `['GET', '/xxx', async (c) => { ... }]`；`c` = `{req,res,url,params}`（`:2199`） |
| `lib/index.js:2213 matchRoute` | 只支持**等段数 + `:param`**，无通配/无正则（新路径别用 `*`） |
| `lib/index.js:1440 sendJson` / `:1556 readBody`（`:1548 MAX_BODY_BYTES`） | 响应/请求体工具；错误用 `error.status` 类型化（`:2203-2208` 统一 catch 按 `status` 回包，否则 500） |
| `lib/index.js:50` Config `httpPrefix` + `:2328` | 前缀来源（**注意 client 写死 `/devtask`，见 P0 债**） |
| `README.md:76-89` | HTTP API 表（否则文档继续漂移） |

**必改（Client，如果 UI 要调）**
| 行 | 改什么 |
|---|---|
| `lib/client.js:14-16 PREFIX`、`:119-129 api(path, opts)` | 调用封装（`api()` 已处理 JSON/错误抛 `Error(data.error)`） |

**必须同步的测试**
- 新建一个 `lib/<feature>.test.js`（照 `archive.test.js`/`file-preview.test.js` 的 A 手法：`registerRoutes(...)` + `registrations[0].handler` + `EventEmitter` 假 req）——**不要**去 `index.test.js` 堆（那里已经 1016 行）
- `lib/index.test.js`：只有“路由与 bridge 的交互契约”（如 409 回滚）才放这里
- 若路由碰需求正文/请求体上限：`lib/requirement-routes.test.js`（跨块 UTF-8、413）
- 若路由要出现在 UI：`lib/ui-regression.test.js`（接线断言）+ `lib/requirement-import-ui.test.js`（真执行）
- `lib/file-preview.test.js` 是最短的模板（75 行，2 用例，含真实临时目录 + 越界拒绝）

> 最容易漏的：新路由忘了走 `sendJson` 而直接 `res.end(JSON.stringify(...))` → `Content-Type` 缺失、前端 `res.json()` 也能过但错误处理不一致；以及忘了在 catch 里用 `error.status`。

---

## 9. 证据强度与未知项

**强证据（我执行/哈希/计数过）**：测试 389/389 通过（3.85s）、`node --test lib/` 假绿、两个 repro 脚本 exit 0 与断言输出、三个 tgz 的 SHA-256 差异表、worktree↔tgz218↔安装副本 40/40 同哈希、git HEAD 版本、diff 行数、行数/用例数/静默 catch/`assert.match(src)`/`mkdtemp` 计数、`node_modules` junction 指向。

**推断（可反驳）**：版本号第三位 = 发布序号；发布流程 7 步；主开发在别处；“8.251→9.10 是一次人工家族对齐”；`.gitattributes` 注释里的 8589/8475 行示例与当前 `index.js`（2338 行）不匹配（可能是更早的大文件或从兄弟仓复制来的注释，未能确证）。

**未知（本机无法验证）**：npm 上的真实发布时间/下载量/序号对应；`npm publish` 是否由 CI 或人工执行；0.1.x 宿主上的实际兼容性（本机只有 0.2.1-rc.2）；`~/.dsh/_removed-backup-20261024` 与版本演进的关系。

---

## 10. 复现指南（交给下一位）

```powershell
cd D:\dsh-knj\dsh-knj-workflow

# 1) 测试全绿（正确姿势）
node --test 'lib/*.test.js'                    # 389 pass / ~3.9s

# 2) 两个确定性复现脚本（exit 0 = 符合预期）
node lib/repro-ts-review-loop.mjs              # 驳回回环：已修
node lib/repro-zero-outedge.mjs                # 零出边：运行期已拦，静态校验仍放过

# 3) 发布物三方对账
#    worktree 37 lib 文件 == reo/tmp/tgz-2026.10.218/package/lib == ~/.dsh/profiles/web/node_modules/dsh-knj-workflow

# 4) 本次调查留下的中间产物
#    reo/tmp/test-all.log        TAP 全量输出（2352 行）
#    reo/tmp/tgz-2026.10.{216,217,218}/package/   三个 tgz 解包
#    reo/tmp/symbol-map.txt      各源码文件的函数/类 → 行号
#    reo/tmp/test-headers.txt    23 个测试文件的头部注释（含运行命令）
#    reo/tmp/repro-{ts,zero}.txt 两个 repro 的实际输出
```
