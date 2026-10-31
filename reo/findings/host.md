# dsh-knj-workflow · Host 侧代码级逆向

> 目标：`dsh-knj-workflow` v2026.10.218（DSH 插件「KNJ 开发任务编排插件」）的 **Host 运行时**实现。
> 本文只覆盖 Host（`lib/index.js` / `graph.js` / `orchestrator.js` / `assist-*` / `uploads|attachments|requirement`），
> Client（`lib/client.js`，4293 行）不在范围内，只在「契约边界」处引用其行号作为交叉证据。

---

## 0. 证据基准（先读这段，决定后面每个行号怎么用）

| 项 | 结论 | 证据 |
|---|---|---|
| 源码形态 | 无 TS 源、无构建步骤，`lib/*.js` 即发布物（ESM，`"type": "module"`） | `package.json:7,17-27,37-41` |
| 工作区源码 == npm 包 | 对 `.218.tgz` 内 10 个 Host 源文件逐行 diff，**差异为 0** | `tar -xOzf dsh-knj-workflow-2026.10.218.tgz package/lib/<f>` + `Compare-Object`（见 §12） |
| 行号基准 | 本文行号 = `read` 工具显示的**总行号（含空行）**。任务书里的 2260 / 602 / 385 是「非空行」计数 | `index.js` 总行 2338（非空 2260）；`graph.js` 638（602）；`orchestrator.js` 410（385） |
| Host 运行时版本 | 本机安装 `@deepseek-ai/dsh@0.2.1-rc.2`；插件 peer 声明 `>=0.1.1-rc.2 <0.3.0-0` | `package.json:13-16,42-51`；`node -e` 读宿主 package.json |
| 证据强度标记 | ✅ 源码实证 ／ ◐ 推断（有依据但未运行验证）／ ？未知 | — |
| 宿主源码引用 | `<dsh>/node_modules/@deepseek-ai/...`，`<dsh>` = `C:\Users\MrYang\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` | — |
| 实测数据 | `~/.dsh/dev-orchestrator/` 有真实数据：`workflows.json` 41,723 B、`knj-host-debug.log` **3,131,693 B / 24,927 行（仍在增长）**、`tasks/` 24 个、`uploads/` 8 个 | 目录实测（只读，2026-10-24 22:2x） |

---

## 1. 模块地图

| 文件 | 行数 | 职责 | 被谁 import | 生产链路? |
|---|---|---|---|---|
| `lib/index.js` | 2338 | 插件入口 + DevTaskStore + WorkflowBridge + 24 条 HTTP 路由 + `/dev-task` 命令 + scheduler 服务 | DSH loader | ✅ 全部 |
| `lib/graph.js` | 638 | 图纯函数：校验、BFS 排序、运行态推导、**SVG 连线路由几何** | `index.js:18`、`assist-edits.js:22`、测试 | 部分（见 §7.5） |
| `lib/orchestrator.js` | 410 | **workflow 引擎沙箱脚本**（无 require/fs/network），图遍历执行体 | 运行时 `readFileSync` 后作为 script 字符串交给引擎（`index.js:1197`） | ✅ |
| `lib/assist-edits.js` | 284 | AI 编辑动作引擎：8 种动作的语义预检 + 应用 + 整批回滚 | `index.js:20` | ✅ |
| `lib/assist-rules.js` | 166 | 《流程配置规范》12 节文本，AI prompt 的规范来源 | `assist-prompt.js:14` | ✅（被拼进 prompt） |
| `lib/assist-prompt.js` | 130 | 图摘要 + 规则卡 + 历史 + 指令 → 完整 prompt | `index.js:19` | ✅ |
| `lib/assist-script.js` | 52 | AI 助手编排脚本（薄壳，沙箱内 `await agent(...)`） | `index.js:627` 读文件 | ✅ |
| `lib/attachments.js` | 184 | 内置通用附件：规范化/上限/**物化到工作区**/同名去重/回滚 | `index.js:31` | ✅ |
| `lib/uploads.js` | 157 | 上传暂存 `uploads/<uploadId>/<name>`、惰性清理 | `index.js:30` | ✅ |
| `lib/requirement.js` | 86 | 需求文本规整、标题派生、8000 字阈值与注入格式 | `index.js:21-29` | ✅ |
| `lib/index.d.ts` | 31 | 手写类型（**仅** scheduler 契约 + name/inject/Config/apply） | — | 发布物 |
| `lib/*.test.js` ×23 | ~7000 | 测试（随包发布，见 §10-R11） | node:test | 发布物 |

依赖方向（生产）：`index.js` → {graph, assist-prompt, assist-edits, requirement, uploads, attachments}；`assist-prompt` → `assist-rules`；`assist-edits` → `graph.validateWorkflow`。`orchestrator.js` 与 `assist-script.js` **不 import 任何模块**（沙箱限制，`orchestrator.js:18-19`、`assist-script.js:14-15` 均注明「内联，勿偏离」）。

---

## 2. 插件契约

### 2.1 包清单与入口

| 字段 | 值 | 证据 | 说明 |
|---|---|---|---|
| `name` / `version` | `dsh-knj-workflow` / `2026.10.218` | `package.json:2-3` | 版本号即日期式 |
| `type` | `module`（ESM） | `package.json:7` | 无 CJS 入口 |
| `main` / `types` | `./lib/index.js` / `./lib/index.d.ts` | `package.json:17-18` | |
| `exports["."]` | `{types, default}` → `lib/index.js` | `package.json:19-23` | |
| `exports["./client"]` | `lib/client.js` | `package.json:24` | **必须存在**，否则 dsh-client-modules 直接抛错 |
| `exports["./orchestrator"]` | `lib/orchestrator.js` | `package.json:25` | 便利导出（运行时实际用 `import.meta.url` 读文件） |
| `dsh.bundle.patch` | `./cordis.patch.yml` | `package.json:28-31` | Host 行插入 |
| `dsh.client` | `{platform:"web", inject:[]}` | `package.json:32-35` | Client 侧发现声明 |
| `files` | `["lib","cordis.patch.yml","README.md"]` | `package.json:37-41` | 整个 lib 进包（含 23 个 test） |
| `engines` / peerDeps | node≥20；dsh 0.1.1-rc.2 ~ <0.3.0；cordis ^4.0.1；schemastery ≥3.18 | `package.json:13-16,42-51` | |
| `scripts` | 只有 `pack: pnpm pack` | `package.json:61-63` | **无 test/lint 脚本** |

### 2.2 Bundle patch：只插一行，不动宿主

```yaml
- insert:
    - id: knj-workflow
      name: dsh-knj-workflow
      config:
        httpPrefix: /devtask
```
（`cordis.patch.yml:14-18`）

机制（宿主实证）：patch 项解构 `{id, insert, name, ...overrides}`；`insert` 无 `id` 时直接 `data.push(...insert)` 追加到**入口列表顶层**；有 `id` 时目标必须是 `group` 才 `target.config.push(...)`，否则 warn 跳过。见 `@deepseek-ai/dsh-app-boot/lib/index.js:72-90`。所以本插件是被**追加到 profile cordis 树顶层**的一个普通行，不是 group 成员。

`cordis.patch.yml:5-13` 的注释解释了**为什么只 insert**：0.2 起 `workflow-worker-thread` 行 id 已不存在（补丁会 entry not found），且 `workflowEngine` 活在 agent-preset 隔离 realm，宿主 realm 顶层 enable `tool-workflow` 只会 pending。✅ 与 `index.js:54-58` 的 `inject` 注释一致。

### 2.3 模块导出契约

| 导出 | 位置 | 用途 |
|---|---|---|
| `name` = `'dsh-knj-workflow'` | `index.js:46` | 插件名 |
| `Config`（schemastery） | `index.js:48-52` | `dataRoot:''`、`httpPrefix:'/devtask'`、`orchestratorScript:''` |
| `inject = ['webServer','agents']` | `index.js:58` | **硬依赖**；`workflowEngine` 故意不注入 |
| `apply(ctx, config)` | `index.js:2308-2338` | 唯一入口 |
| `DevTaskStore` | `index.js:111` | 导出供测试 |
| `WorkflowBridge` | `index.js:576` | 导出供测试 |
| `RunAlreadyActiveError` | `index.js:395-400` | 路由据此回 409 |
| `createKnjWorkflowSchedulerService` | `index.js:407` | 给 `dsh-scheduler` 的进程内服务 |
| `MAX_BODY_BYTES` / `readBody` / `registerRoutes` | `index.js:1548,1556,1598` | 导出**只为测试直接驱动 handler**（注释 `index.js:1597`） |

**惰性 `ctx.get()` 的服务（全部可选）**：`agentPresets`（`index.js:612,1104`）、`commands`（`2229`）、`sessionQuery`（`767`）、`workflowEngine`（经 preset 读口，`553-564`）。这是本插件最重要的兼容策略：宿主版本差异只影响可选能力，不会让插件 pending。

### 2.4 Client 侧如何被发现

`dsh-client-modules` 扫描 Loader 各行的包清单：读 `pkg.dsh.client`，`platform !== 'web'` 直接跳过；再要求 `exports["./client"]`，缺失即 `throw`；然后 `clientPath = join(dirname(pkgJson), clientRel)`，并把 `inject/external/immediately` 带出。见 `@deepseek-ai/dsh-client-modules/lib/index.js:720-749`（关键判定 732-738）。本插件 `dsh.client.inject` 为空数组，即「不声明信息性依赖边」；其 4293 行客户端全部集中在 `lib/client.js` 单文件。

### 2.5 生命周期时序（`apply`）

```
apply(ctx, config) [index.js:2308]
├─ home = process.env.DSH_HOME || ~/.dsh                  :2309
├─ dataRoot = config.dataRoot || join(home,'dev-orchestrator') :2310
├─ store = new DevTaskStore(dataRoot)                      :2311
├─ uploads = new UploadStore(join(dataRoot,'uploads'))     :2313
├─ ctx.effect(()->(){ disposed=true; bridge?.cancelAll() }) :2319-2322  ← 卸载时取消全部 run
└─ store.init().then(...)                                  :2324   ← 异步，apply 不 await
   ├─ if (disposed) return                                 :2325
   ├─ bridge = new WorkflowBridge(...)                      :2326
   ├─ ctx.effect(provide 'knjWorkflowScheduler')            :2327
   ├─ registerRoutes(ctx, store, bridge, httpPrefix, uploads) :2328
   ├─ registerCommands(ctx, store, bridge)                  :2329
   ├─ uploads.pruneStale()                                  :2331-2333
   └─ logger.info('ready @ dataRoot')                       :2334
   └─ .catch(logger.warn('init failed: ...'))               :2335-2337
```

⚠️ 这里埋了一个**顺序耦合**：`registerCommands` 在 `registerRoutes` 之后；它抛错会跳过后续日志（见 §10-R1）。

### 2.6 与宿主 0.2.1-rc.2 的契约逐项核对

| 宿主 API | 插件用法 | 宿主 0.2.1 现状 | 判定 |
|---|---|---|---|
| `webServer.register({kind,path,handler})` | `index.js:2210`，`kind:'prefix'` | `WebRoute {kind:'exact'|'prefix', path, handler(req,res)}`；prefix 匹配 `p` 与 `p/<anything>`，最长前缀优先 | ✅ 实证（`dsh-host-webserver/lib/types/index.d.ts:31-40`，`lib/index.js:326-339,494-505`） |
| `workflowEngine.start(req)` | `index.js:1196-1216`、`629-634` | `WorkflowStartRequest {script, meta, args?, parent, signal?, ...}`；返回 `WorkflowRun {id, meta, result, cancel, dispose}`；`result` 永不 reject | ✅ 实证（`dsh-workflow/lib/types/runtime-types.d.ts:15-44`） |
| `engine` 从哪拿 | `resolveWorkflowEngine`：`presets.serviceFor(agent,'workflowEngine')` → 回落 `agent.scope.ctx.get` | `AgentPresets.serviceFor(agent,name)` 存在（`signature serviceFor(...)`） | ✅ 实证（`dsh-agent-preset-registry/lib/typert.host.js:236-237`，`lib/index.js:725-727`） |
| `workflow/*` 事件 | `ctx.on('workflow/phase'|'agent-start'|'agent-end'|'log')`，`(info,payload)` | 事件签名与 `WorkflowRunInfo{id,meta}` 一致 | ✅ 实证（`dsh-workflow/lib/types/index.d.ts:32-74`） |
| `agents.currentInitiator/roots/create` | `index.js:1101-1151`、`613` | 三方法均存在；`CreateAgentOptions{sessionId, meta{cwd,agentPreset}, agentOptions, setup}` | ✅ 实证（`dsh-agent/lib/types/index.d.ts:48-104,218,278,364`） |
| `presets.resolve(id)` / `presets.mount(ctx,id)` | `index.js:1124-1144` | `async resolve(id?)`、`async mount(ctx,id?)` | ✅ 实证（`dsh-agent-preset-registry/lib/types/index.d.ts:77,91`） |
| `sessionQuery.readSession/readSurface/listEvents` | `index.js:773,818-820` | 三方法均存在 | ✅ 实证（`dsh-session-query/lib/types/index.d.ts:74,111,127`） |
| `session/event` | `index.js:809` | `'session/event'(this: Scoped<Session>, session, event)` | ◐ 存在，但 `Scoped<Session>` 的派发作用域是否覆盖 root ctx 未运行验证 |
| `commands.register(definition)` | `index.js:2234-2302` 传 `{name,description,execute}` | `CommandDefinition` 要求 **`handler` 必填**，`normalizeDefinition` 对缺失直接 `throw TypeError`；结果形状 `{kind:'success'|'error',text}`（**不再接受 `{success,text}` 和 `execute`**） | ❌ **契约不符**；已运行时复现：`new CommandRuntime(new Context()).register({name:'dev-task',description:'x',execute(){}})` → `TypeError: command "dev-task" handler must be a function`（见 §10-R1） |

---

## 3. HTTP API 全量清单

注册方式：手写 `routes` 数组（`index.js:1599-2188`）+ 单个 `handler` 顺序遍历匹配（`index.js:2190-2210`），**不用** 宿主 router。
- 前缀剥离：`path = url.pathname.slice(prefix.length) || '/'`（`index.js:2192`）
- 参数：`:id` 段 `decodeURIComponent`（`2219`）
- 404：`{error:"no route for METHOD path"}`（`2202`）
- 错误：`err.status` 优先，否则 500；`headersSent` 后只 end（`2204-2207`）
- 无鉴权、无 CORS 头（依赖 loopback + 同源）◐

| # | 方法 | 路径（前缀后） | handler 行 | 入参/校验 | 成功 | 失败 |
|---|---|---|---|---|---|---|
| 1 | GET | `/health` | 1601 | 无 | 200 `{ok,plugin,dataRoot}` | — |
| 2 | GET | `/models` | 1605-1646 | 无参；**手写 YAML 扫描** `settings.yaml`（候选 `store.root/../settings.yaml`、`~/.dsh/settings.yaml`） | 200 `{models:[{provider,model,label}]}` | 解析失败→空数组（静默） |
| 3 | GET | `/diag` | 1648-1671 | 无 | 200：ctxKeys、hasWorkflowEngineGlobal、roots 的 scope/loopCtx 探测结果 | — |
| 4 | GET | `/workflows` | 1673 | 无 | 200 `{workflows:[full]}`（含 x/y 坐标） | — |
| 5 | POST | `/assist` | 1677-1691 | body `{workflow{nodes[],edges[]}, message, history?}`；不合法 400 | **202** `{requestId}` | 400；500（startAssist 抛错） |
| 6 | GET | `/assist/progress` | 1692-1699 | `?id=&since=` | 200 `{events[],stream?,done,result?,error?}` | 400 无 id；404 未知 id |
| 7 | POST | `/workflows` | 1700-1704 | body=工作流 | 200 `{workflow}` | 校验失败→**500**（见 R7） |
| 8 | PUT | `/workflows` | 1705-1709 | 同上（upsert 语义与 POST 完全相同） | 200 `{workflow}` | 500 |
| 9 | DELETE | `/workflows/:id` | 1710-1713 | 无存在性校验 | 200 `{ok:true}`（幂等） | — |
| 10 | POST | `/uploads` | 1718-1732 | body `{name,dataBase64}`；body 上限 `UPLOAD_BODY_BYTES` | 200 `{uploadId,name,size}` | 400 `{error,code}`；500 无 uploads 服务；413 body 超限 |
| 11 | GET | `/tasks` | 1734-1742 | `?archived=1/true`、`?q=` | 200 `{tasks:[listItem]}` | — |
| 12 | GET | `/tasks/:id` | 1743-1754 | — | 200 `{task}`（无快照时注入只读 fallback） | 404 |
| 13 | POST | `/tasks` | 1755-1854 | body：workflowId/description/title/id/notes/storyCode/inputs/fileInputs/attachments/cwd/model/provider/autoStart | 200 `{task}` | 400 无工作流/非法 id/缺必填文件入参/附件超限；409；500（并落库 failed） |
| 14 | POST | `/tasks/:id/start` | 1855-1876 | — | 200 `{task,runId}` | 404；409（isRunning 或 RunAlreadyActive）；500 |
| 15 | POST | `/tasks/:id/cancel` | 1877-1885 | — | 200 `{task}`（status=cancelled 先落库再 cancel run） | 404 |
| 16 | POST | `/tasks/:id/rerun-stage` | 1886-1942 | body `{stageId}`；stageId 必须存在于 stageStates | 200 `{task,runId}` | 400 stageId required/not found；404；409；500 |
| 17 | POST | `/tasks/:id/resume` | 1943-2028 | body `{mode:'resume'|'rerun'}`（其他值→resume） | 200 `{task,runId,mode}` | 404；409（正在取消/运行）；500 |
| 18 | POST | `/tasks/:id/decide` | 2030-2100 | body `{decision,feedback?}`；要求 status=waiting-human；decision 必须在 routes label 内（`approve/reject` 兼容映射） | 200 `{task,runId}` | 400 非等待态/非法决策；404；409（回滚 humanState）；500 |
| 19 | POST | `/tasks/:id/archive` | 2101-2108 | — | 200 `{ok:true}`（写 `archivedAt`） | 404 |
| 20 | POST | `/tasks/:id/restore` | 2109-2116 | — | 200 `{ok:true}`（删 `archivedAt`） | 404 |
| 21 | DELETE | `/tasks/:id` | 2117-2122 | — | 200 `{ok:true}`（先 cancelTask 再删目录） | — |
| 22 | GET | `/tasks/:id/stages/:stageId` | 2124-2127 | — | 200 `{data}` 或 `{data:null}` | — |
| 23 | GET | `/tasks/:id/results` | 2129-2132 | — | 200 `{results}`/`{results:null}` | — |
| 24 | GET | `/tasks/:id/file` | 2137-2187 | `?path=`；须在 task.cwd 内（`relative` + `realpath` 双重校验） | 200 文件 `{path,content}` / 目录 `{path,isDir,entries[]}` / >200KB `{path,meta,tooLarge}` | 400 无 cwd/无 path/越界/非文件；404 任务缺失或读失败 |

### 3.1 与 README 的对账（漂移）

README 的 HTTP API 表只有 11 行（`README.md:74-88`）。逐条对账结果：

| 类别 | 内容 |
|---|---|
| README 有、代码有 | `/health`、`/workflows`(GET/POST/PUT)、`DELETE /workflows/:id`、`/tasks`(GET/POST)、`GET /tasks/:id`、`POST /uploads`、`start/cancel/resume`、`rerun-stage`、`GET .../stages/:stageId`、`/assist`、`/assist/progress` |
| **README 缺（8 条）** | `GET /models`、`GET /diag`、`POST /tasks/:id/decide`、`POST /tasks/:id/archive`、`POST /tasks/:id/restore`、`DELETE /tasks/:id`、`GET /tasks/:id/results`、`GET /tasks/:id/file` |
| README 缺的语义 | 409 并发守卫、413 body 上限（10MB / 上传 ~44.7MB）、`POST /tasks` 的 `autoStart`、`archived=1` 之外还支持 `archived=true`、`POST /tasks` 可传 `model/provider/cwd/storyCode/notes`、fallback 快照标记 `workflowSnapshotFallback` |
| README 写错（配置） | 配置表只列 `dataRoot`/`httpPrefix`（`README.md:69-72`），漏 `orchestratorScript`（`index.js:51`）且未说明它其实是**脚本源码**而非路径（`index.js:1197` 直接 `engine.start({script: this.orchestratorScript || readFileSync(...)})`）；`dataRoot` 默认值描述漏 `DSH_HOME` 覆盖（`index.js:2309`） |
| README 写错（编排器参数） | `README.md:102-109` 称 `args.config = {name,description,stages:[...]}`、`args.resumeFrom`、`args.rerunStage`。实际：`args.config = {id,name,inputs,nodes[],edges[]}`；**`resumeFrom`/`rerunStage` 编排器从未读取**（`orchestrator.js` 全文只消费 `config/task/inputs/initialResults/decided/decision`，见 §6.2），真正断点协议是 `initialResults` + `skipSet`；README 也漏了 `args.decided` 与 `args.decision` |
| README 写错（数据目录） | 未记录 `tasks/<id>/results.json`、并行分片 `stages/<node>-<n>.json`、工作区标记文件 `.knj-materialized-names.json`、`knj-host-debug.log`（见 §4.1） |
| README 架构图 | `README.md:39-40` 称「每阶段子 agent 结果落盘」，但实际**由 Host 通过 `[knj-checkpoint]` 日志落盘**（`index.js:1302-1313`；编排器注释 `340-341` 明确「subagent 常不遵守写文件指令，不能依赖它」） |

---

## 4. 持久化：DevTaskStore

### 4.1 目录布局（默认 `~/.dsh/dev-orchestrator/`，实测存在）

| 路径 | 内容 | 写入方 | 证据 |
|---|---|---|---|
| `workflows.json` | `{workflows:[...]}` 全部工作流（含 x/y 布局坐标、`schemaVersion:2`、`revision`） | `saveWorkflow/deleteWorkflow` | `index.js:114,145-173`；实测 41,723 B |
| `tasks/<id>/task.json` | 任务元数据 + `workflowSnapshot` 全量副本 + `stageStates[]` + `decisions[]` + `humanState` | `saveTask/mutateTask` | `index.js:183,220-258`；实测单任务 3,672 B（样本含 6 节点快照） |
| `tasks/<id>/results.json` | 终态 `result.value.results`（节点 id → 输出） | `saveResults`（终态/paused） | `index.js:185,1404,1433` |
| `tasks/<id>/stages/<node>.json` | 每节点断点产物 | `writeStage`（来自 checkpoint 日志） | `index.js:184,266-268,1311` |
| `tasks/<id>/stages/<node>-<n>.json` | 并行节点分片断点 | 同上（`node.id` 换成 `node-N`） | `index.js:1982`、`orchestrator.js:326` |
| `tasks/<id>/requirement.md` | 仅当需求 >8000 字：全文 | `spillRequirementBeforeRun` | `index.js:1532-1545` |
| `uploads/<uploadId>/<safeName>` | 上传暂存（24h TTL） | `UploadStore.stage` | `uploads.js:17-23,80-102` |
| `knj-host-debug.log` | 运行诊断 JSONL，**无轮转** | `dbg()` | `index.js:35-36,38-44`；实测 **3,131,693 B / 24,927 行**（仍增长） |
| `<cwd>/.knj-inputs/<taskId>/<file>` | 文件入参/附件物化目标 | `materializeFileInputs/materializeAttachments` | `index.js:1486-1517`、`attachments.js:95-173` |
| `<cwd>/.knj-inputs/.gitignore` | 内容 `*` | 同上 | `index.js:1494-1497`、`attachments.js:108-111` |
| `<cwd>/.knj-inputs/<taskId>/.knj-materialized-names.json` | 本任务已物化的附件名（区分“自己的旧文件 vs 用户新选同名文件”） | `attachments.js:119,166` | ✅ 巧妙设计，见 §8 |

工作区内**没有** `.tasks/` 之类目录；`defaultWorkflow()` 的 prompt 里要求节点建 `.tasks/<id>/`（`index.js:318-325`）属于**工作流内容**而非 Host 行为。

### 4.2 写入时机与并发控制

| 原语 | 行 | 语义 |
|---|---|---|
| `writeJson(p, value)` | 70-94 | 原子写：`tmp-<ts>-<uuid>` → `rename`；失败回退 `rm(tmp)` + 最多 3 次直接写（25/50/75ms 退避）。注释说明 Windows 上 rename 到被占用目标偶发 EPERM |
| `_wfMutate(fn)` | 120-125 | `workflows.json` 的读-改-写串行链（`_wfQueue`），避免并发 save/delete 互相覆盖 |
| `saveTask(task)` | 220-235 | 每 taskId 一条 Promise 链（`_queues`），串行写 `task.json`；队列自身 catch 吞错防断链 |
| `mutateTask(id, mutator)` | 241-258 | **队列内**「读最新 → mutator 原地改 → 写」，并发事件回调不会后写覆盖先写 |
| `writeStage` / `saveResults` | 266-274 | **不过队列**，但走 `writeJson` 原子写；不同文件并行写安全 |
| `readJson(p, fallback)` | 66-69 | 任何异常（含 JSON 损坏）→ 静默返回 fallback ⚠️（见 R3） |
| `assertSafeId(id)` | 178-182 | `^[a-zA-Z0-9._-]+$` 且不含 `..`、不是纯点；`taskFile/stageFile/resultsFile` 全部先校验（防路径穿越，注释记录「本插件栽过一次」） |

### 4.3 启动迁移与种子

```js
// index.js:131-141
const wf = await readJson(this.workflowsFile, { workflows: [] });
if (!Array.isArray(wf.workflows)) wf.workflows = [];
// 旧线性格式（含 stages、无 nodes/edges）直接废弃，不迁移
const before = wf.workflows.length;
wf.workflows = wf.workflows.filter((w) => !(Array.isArray(w.stages) && !Array.isArray(w.nodes)));
if (wf.workflows.length === 0) wf.workflows = [defaultWorkflow()];
```

- **迁移策略**：schemaVersion 只有「写新值」，没有逐版本迁移器。旧线性格式（`stages` 无 `nodes`）被**静默丢弃**；`prepareWorkflowForSave` 固定写 `schemaVersion:2`、`revision=existing.revision+1`（`graph.js:374-383`）。✅
- **种子**：只要 `workflows.length === 0` 就注入 `defaultWorkflow()`（5 阶段中文流水线，`index.js:280-387`）→ **用户删光工作流后重启会“复活”默认工作流**（副作用，非 bug 但需知晓）。
- `task.json` 无 schemaVersion/无迁移：字段演进靠「缺省即回退」（如 `workflowSnapshot` 缺失时 `GET /tasks/:id` 注入 fallback，`index.js:1749-1752`）。

### 4.4 实测样本（`task-mvlbsv07`）

- `workflowSnapshot` 与 `workflowId/workflowRevision` 一起持久化（`task.json:6-129`）：**任务运行用创建时快照**，与后续工作流修改解耦（`index.js:1086-1093`）。
- `stageStates[]` 结构：`{id,title,status,startedAt,finishedAt?,sessionIds[]}`；本例 `task-3` 为 `skipped`（XOR 未走分支），`decisions[]` 记录了人工通过的 label 与 feedback，`humanState:null`（决策后清空）。
- `parentSessionId = "knj-task-<taskId>-<8hex>"`（动态专用 parent，`index.js:1128`）。
- 快照里节点带 `x/y`：**布局坐标由 Host 存储、由 Client 管理**，AI 编辑通道禁止写（`assist-edits.js:31,66`）。

---

## 5. 编排执行：WorkflowBridge

### 5.1 引擎解析（唯一的兼容分支）

```js
// index.js:553-564
function resolveWorkflowEngine(presets, agent) {
  try {
    const viaPreset = presets?.serviceFor?.(agent, 'workflowEngine');
    if (viaPreset) return viaPreset;
  } catch (error) { dbg('resolveWorkflowEngine: serviceFor 失败，回落 scope.get', {...}); }
  const scopeCtx = agent?.scope?.ctx ?? agent?.loopCtx;
  return scopeCtx?.get?.('workflowEngine');
}
```

设计要点（`index.js:538-552` 注释）：0.2 起引擎在 agent preset 的 `isolate:{workflowEngine:true}` group 里，`agent.scope.ctx.get()` **恒 undefined**，唯一读口是 `agentPresets.serviceFor(agent,name)`；旧宿主没有 `serviceFor`，回落 `scope.get`。失败给可操作报错 `missingEngineMessage`（`567-574`：区分「agentPresets 服务不可用」与「preset 未含 dsh-workflow-ptc」）。✅

### 5.2 `startTask` 启动流水线（单点 owner）

| 步 | 动作 | 行 |
|---|---|---|
| 1 | **同步占位**并发守卫：`runs.has` → `RunAlreadyActiveError`；`runs.set(taskId, {})` 在任何 `await` 之前完成（堵 TOCTOU） | 1078-1084 |
| 2 | `workflow = task.workflowSnapshot ?? store.getWorkflow(workflowId)`；缺快照则回写（详情页/运行图/审批卡依赖它） | 1087-1093 |
| 3 | 取 `agents` / `agentPresets`；`seed = currentInitiator() ?? roots()[0]` | 1101-1107 |
| 4 | `parentCwd = task.cwd \|\| seed?.session?.header?.cwd \|\| null`；有 `agents.create` 且（seed 或 cwd）→ 建**专用 parent**：`sessionId:\`knj-task-${task.id}-${uuid8}\``、`meta:{cwd,agentPreset}`、`setup: presets.mount` | 1112-1150 |
| 5 | 建 parent 失败 → warn + 回退现有会话；全无 → 三种可操作报错 | 1147-1162 |
| 6 | `materializeFileInputs` → `materializeAttachments` → `resolveAndVerifyFileInputs` → `spillRequirementBeforeRun`（全部「启动前」单点） | 1165-1173 |
| 7 | `task.parentSessionId = parent.id` → `store.saveTask(task)` | 1177-1178 |
| 8 | `engine.start({script, meta:{name,description}, args, parent})`；失败则 `parentHandle.dispose()` | 1184-1220 |
| 9 | `listeners/runs/parentHandles` 登记 → `monitorRun(task, run)` | 1222-1227 |
| 10 | 任一步抛错：若 `runs` 仍是 pendingMarker 则 delete（允许重试） | 1228-1234 |

`engine.start` 的 args（实测上下文，`index.js:1196-1216`）：

```js
args: {
  config: workflow,
  task: { id, title, taskDir, inputDescription?, description?, storyCode?, cwd? },
  inputs, decision?, initialResults?, decided?, resumeFrom?, rerunStage?
}
```

注意：`taskDir = join(this.store.tasksDir, task.id)`（`1190`）指向 **`~/.dsh/dev-orchestrator/tasks/<id>`**，即断点目录在家目录、不在用户工作区（见 R8）。

### 5.3 run 事件 → 任务状态（`monitorRun`，`1238-1376`）

| 事件 | 匹配 | 状态变更 |
|---|---|---|
| `workflow/phase` | `info.id === run.id` | 按 `stageStates[].id === title` 匹配（`phase(node.id)`）；`currentStage = title`；`pending/skipped → running`（`startedAt` 保序）→ `1243-1256` |
| `workflow/agent-start` | 同上 | 取 `agent.phase ?? agent.label`；`label` 不含 `:` 视为节点主体；`sessionIds` **去重追加**；并**强制置回 running**（清 `finishedAt/error`、刷新 `startedAt`）——注释记录「多轮复用同一节点时旧 done 会挡死状态」→ `1257-1287` |
| `workflow/agent-end` | 同上 | 只对 `label` **不含 `:` 且不含 `#`** 的主体标 `running → done`（并行分片 `node #N` 不提前标）→ `1288-1301` |
| `workflow/log` | 前缀 `[knj-checkpoint]` | `JSON.parse` 后 `writeStage(taskId, node, output)`；解析失败静默 → `1305-1314` |
| `run.result` | — | 仅当 `runs.get(taskId) === run`（旧 run 晚到不得覆盖新 run）→ `finalizeTask`；随后**各自独立 try** 地 `ctx.off` 四个监听器（防一个 off 抛错导致 runs 残留）→ `runs.delete` → `run.dispose()` → `parentHandle.dispose()` → `1324-1375` |

**终态唯一来源是 `run.result`，不是 `workflow/end` 事件**（`index.js:1320-1323` 明确：end 事件 payload 不含 `value`，拿它 finalize 会用空 results 覆盖）。

### 5.4 状态机

任务级 `status`：

```
pending ──start──> running ──completed──> success
                     │  └──cancelled──> cancelled
                     │  └──error/其他──> failed
                     └─human 节点──> waiting-human ──decide──> running ...
（正交标记：archivedAt 存在 = 已归档，不改 status；restore 删除该键）
```
证据：`finalizeTask`（`1391-1434`）、`decide`（`2058-2061`）、`archive/restore`（`2101-2116`）。

`finalizeTask` 细分（`1391-1434`）：
- `value.paused` → `waiting-human` + `currentStage=pausedAt` + `humanState={humanId, results}` + `saveResults`（**不写 finishedAt**）→ `1396-1407`
- 否则按 `stopReason`：`completed→success`、`cancelled→cancelled`、其他 `→failed` 且写 `error`
- `stageStates` 修正：`running → done`（cancelled 也算 done，避免误导；失败则 `failed`+error）；`pending` 且不在 `stageLog` → `skipped`（XOR 未走分支/并行未触及）→ `1423-1431`
- 落 `results.json`（`1433`）

`stageStates[].status` 取值：`pending | running | done | failed | skipped`；`deriveRunGraphStates` 另外派生展示态 `passed | waiting`（`graph.js:445-489`，Host 不调用，见 §7.5）。

### 5.5 断点、续跑、重跑

| 入口 | 断点来源 | 清理动作 | 证据 |
|---|---|---|---|
| `POST /resume?mode=resume` | 读 `stages/*.json`：普通节点按文件名；并行节点识别 `node-N` 后缀并要求**分片数完整且序号连续**（`parallelItems` 来自 `workflowSnapshot.nodes[].body.parallelItems`，默认 3） | 不清文件；`stageStates` 保留 `done`，把 `skipped/failed` 重置 `pending`（并清 sessionIds） | `1943-2028` |
| `POST /resume?mode=rerun` | `initialResults={}` | **删整个 stages 目录**；`stageStates` 全量重置 pending | `1958-1963,2004-2009` |
| `POST /rerun-stage` | 只取**目标节点之前**的断点（stage 文件优先，回落 `results.json`） | 清掉目标及之后节点的 stage 文件（正则 `^(.*)-(\d+)$` 去掉分片后缀） | `1886-1942` |
| `POST /decide` | `humanState.results` 作为 `initialResults` | 追加 `decisions[]`；`decided = buildDecidedMap(task)`（每个 human 取最后一条决策） | `2030-2100`、`100-106` |

`buildDecidedMap` 存在的原因（`index.js:97-99` 注释）：两个顺序人工节点的任务若不带历史决策，会在 H1/H2 之间**无限振荡**（后一个决策被前一个的重新暂停吞掉）。

### 5.6 并发守卫与错误语义

- `isRunning(taskId)` = `runs.has`（`590-592`）。路由在改状态前都先问（`1859,1891,1950`），避免「取消后立即续跑」窗口误标 failed。
- `startTask` 内 TOCTOU 双保险：路由预检 + startTask 内同步占位；后者抛 `RunAlreadyActiveError` → 409。
- `decide` 遇 409 会**回滚**：恢复 `humanState`、`status=waiting-human`、并删掉刚追加但未被消费的决策（`2076-2091`）。
- 启动失败（非 409）统一落库 `failed` + `启动失败：...`（`1839-1847`、`1868-1874`、`1934-1940`、`2020-2026`）。
- `cancelTask` 只调 `run.cancel()`（`1379-1383`）；`DELETE /tasks/:id` 先 cancel 再删目录，`finalizeTask` 用 `getTask` 为空提前返回，避免重建孤儿结果（`1392-1393`）。

---

## 6. orchestrator.js：脚本协议与执行语义

### 6.1 沙箱约束

脚本跑在 workflow 引擎沙箱：**无 fs / network / require / import**（`orchestrator.js:18-19`）。因此：
- 图路由/条件/宽松相等/模板解析全部**内联复制**自 `graph.js`（`orchestrator.js:84-178`），注释要求「勿偏离」；
- 断点落盘不能自己写文件，只能 `log('[knj-checkpoint]'+JSON)` 上报，由 Host 落盘（`340-342`）；
- 需求阈值逻辑必须在 Host 算好传入（`194-197` 注释 + `index.js:1191-1195`）。

### 6.2 args 契约（**实际消费** vs README）

| arg | 编排器消费 | 行 | Host 是否传 | README 是否写 |
|---|---|---|---|---|
| `args.config` | ✅ `{nodes[],edges[]}`（缺则抛错） | 22-25 | ✅ | ⚠️ 写成 `stages` |
| `args.task` | ✅ `{id,title,taskDir,inputDescription,description?,storyCode?,cwd?}` | 26-27,198-207 | ✅ | ⚠️ 字段不全 |
| `args.inputs` | ✅ 原样进 `ctx.inputs` | 201 | ✅ | ❌ 未写 |
| `args.initialResults` | ✅ `results` 初值 + `skipSet` | 30-31 | ✅ | ❌ 未写 |
| `args.decided` | ✅ human 历史决策重放 | 38 | ✅ | ❌ 未写 |
| `args.decision` | ✅ 本轮人工决策（消费后置 null） | 363-365 | ✅ | ❌ 未写 |
| `args.resumeFrom` | ❌ **从不读取** | — | ✅（`index.js:1212`，但**无调用方传**） | ✅ 文档化 |
| `args.rerunStage` | ❌ **从不读取** | — | ✅（`index.js:1213`） | ✅ 文档化 |

⇒ README「编排器参数」整节（`README.md:102-109`）与实现**脱节**：真实断点协议是 `initialResults`+`skipSet`，不是 `resumeFrom/rerunStage`。双向死契约（Host 传了没人读、文档承诺了没有实现）。

### 6.3 模板变量与引用解析

`getCtx()`（`orchestrator.js:188-208`）暴露的键：

| 键 | 值 |
|---|---|
| `task` / `taskId` | `{id}` / 任务 id |
| `inputs` | `args.inputs`（含文件入参与 `inputs.附件` 换行路径串） |
| `inputDescription` | Host 预计算：≤8000 字全文；>8000 字「前 6000 字 + 省略说明 + `requirement.md` 路径」；回退 `task.description` |
| `inputTitle` / `storyCode` / `cwd` | 任务标题 / 用户故事编码 / 工作目录 |
| `...results` | **展开所有节点输出** → `${nodeId.字段}` 直接可用 |

解析：`resolveRefs` 正则 `/\$\{(?:ctx\.)?([^}]+)\}/g`（`211-220`），`resolveRefRaw` 按 `.` 逐段、**贪心最长 key 前缀匹配**（`223-235`）；解析不到 → 空串（注释：被跳过分支/拼写错误不应把 `${...}` 原文漏进 prompt）。值非字符串时 `JSON.stringify`（`217`）。

**刻意不自动注入上下文**（`orchestrator.js:289-290`）：prompt 只自动拼两段执行环境信息——`[人工意见]`（一次性，来自 decision.feedback）与 `[工作目录]`（`task.cwd` 存在时）。所以 `defaultWorkflow` 的节点 prompt 都显式写 `${inputDescription}` 等。

### 6.4 执行循环（`executeUntil`，`264-393`）

```
current = 'start'; safety = 0
while (current && current!=='end' && current!==joinId && safety<1000):
  phase(node.id)                       // 事件用 node id，重名节点不串标
  task:
    if skipSet.has(id) → 跳过（delete 后继续）
    countRun(node)                     // maxRuns 保护
    prehook 动作序列
    prompt = [人工意见]\n\n[工作目录]\n\nresolveRefs(body.prompt)
    schema = body.output（file/dir 归一为 string）
    mode==='parallel' → parallel(N thunks)，各写 node-i.json，结果合并为数组
    else → agent(prompt+writeInstr, opts)；输出 null 即抛错
    checkpoint log → stageLog → posthook → nextNode()
  gateway-and 且多出边（split）:
    nestedJoin = findJoin()；parallel(分支 executeUntil(to,nestedJoin))
    任一失败 → 抛「并行分支执行失败」
    分支内 paused 向上传播 → 返回 paused
    current = nestedJoin ? nextNode(nestedJoin) : null
  human:
    args.decision 命中本节点 → matchRoute + humanFeedback + skipSet.delete(route.to) + humanReleased.add
    else decidedMap[node.id] 且未 released → 重放最后去向（不再暂停）
    else → return {paused:true, pausedAt:node.id}
  其他: current = nextNode(current)
若 current 仍是中间节点（safety 用尽）→ 抛「安全步数上限 1000」
```

关键语义：
- **失败即停**：节点无输出 / 并行全失败 / 循环超限都 `throw`；脚本**不吞错**（`395-397` 注释：return 会被引擎判 `completed`，失败任务会被误标 success）。
- **`maxRuns` 默认 3**（`47-59`），按「本轮 run」计数，`resume` 会重置（见 R19）。
- **并行**：`valid = outputs.filter(o != null)`；只要有一个有效就算成功，但分支（gateway-and）失败是严格的（`330-331,355-356`）；并行分片按一轮计 1 次 `countRun`（注释 `282`）。
- **human 回环**三件套（`humanFeedback` / `decidedMap` / `humanReleased`，`34-44,361-382`）解决「驳回 → fix → 回到同一 human」时旧决策被反复重放导致 fix 空转到 maxRuns 的问题；`humanReleased` 保证一个 human 在单次 walk 内只被自动放行一次。
- 返回值（`400-410`）：`{workflow,taskId,nodeCount,stageLog,results,ok,current, paused?,pausedAt?,error?}`；Host 用 `paused` 判 `waiting-human`、用 `stageLog` 判 `skipped`、用 `results` 落盘。

### 6.5 网关与条件

- `nextNode`（`121-159`）：`human` 返回 null；单出边直接走；**多出边**按 `when` 匹配「声明顺序最先命中」，`default` 边若带条件也参与匹配，兜底优先级「无条件 default > 任一 default」；零出边时仅 `end` 合法，否则抛「断头」错误。
- `when.field` 三种写法：裸字段名（XOR 取唯一上游输出 / task 多出边取自身输出）、`${node.field}`、裸点号路径（`86-102` 注释 + `matchCondition`）。
- `when.value` 支持 `${...}` 引用任务变量（`143`，如按 `${inputs.level}` 分流）。
- `looseEq`（`107-118`）双向宽松：`true↔'true'`、`5↔'5'`，兼容 subagent 输出的字符串化布尔/数字。
- `gateway-and` 的 join 判定：从 split 出边 BFS 找**第一个多入边**的 `gateway-and`（`162-177`），与 `graph.findJoin` 同语义。

---

## 7. 图模型与校验（graph.js）

### 7.1 数据模型

```
workflow = { id, name, description?, schemaVersion:2, revision:n, inputs:[], nodes:[], edges:[] }
node     = { id, type, title?, x?, y?, inputs:[], body?, routes?, approveTo?, rejectTo?, displayFrom?, maxRuns?, prehook?, posthook?, skill? }
  type ∈ { start, end, task, gateway-xor, gateway-and, human }        (graph.js:16)
  task.body = { prompt, mode:'single'|'parallel', parallelItems?, output?:JSONSchema, skill? }
  human.routes = [{label, to, tone?}]  ← 兼容旧 approveTo/rejectTo（推导为 通过/驳回）  (graph.js:82-88)
edge     = { from, to, when?:{field, op:'eq'|'neq'|'in', value}, default?:true }
inputs[] = { name, label, required, type:'text'|'file' }               (graph.js:19,34-73)
```

输入参数名黑名单 `INPUT_NAME_INVALID = /[\s.\\/:*?"<>|]/`（`graph.js:26`），注释解释**点号必须拒**：`${inputs.a.b}` 按 `.` 逐段取值会永远取不到；中文名允许。

### 7.2 `validateWorkflow` 检查项（`graph.js:124-247`）

| # | 检查 | 行 | 报错样例 |
|---|---|---|---|
| 1 | workflow 是对象 / nodes、edges 是数组（缺省按空数组） | 126-130 | `workflow 必须是对象` |
| 2 | 任务输入声明校验（类型/重名/非法字符） | 134-135 | 见 §7.3 |
| 3 | `nodes` 非空 | 137 | `nodes 不能为空` |
| 4 | 节点 id 必填、唯一、type ∈ 6 种 | 141-147 | `节点 id 重复: x` |
| 5 | **有且仅有一个 start / end** | 150-153 | `必须有且仅有一个 start（当前 2 个）` |
| 6 | 边 from/to 必须存在；重复边（同一对节点只能一条） | 164-169,188-193 | `重复边: a → b` |
| 7 | **孤立节点**：除 start 外入度 0（human routes 虚拟边计入度数） | 157-184 | `节点 x 无入边（孤立）` |
| 8 | `gateway-xor`：出边 ≥2、必须有 default、非 default 边必须带 when | 195-201 | `排他网关 x 缺少 default 出边` |
| 9 | `task` 多出边：非 default 边必须带 when（死边） | 203-209 | `节点 x 有多条出边，其中 1 条…永远不会命中` |
| 10 | `gateway-and`：必须 split（多出单入）或 join（多入单出），不能混合 | 210-217 | `拓扑非法` |
| 11 | **human 不得在并行分支内**（`branchNodes` 分析，含 human 虚拟边） | 218-231 | `请移到 join x 之后` |
| 12 | `human`：routes 至少一条、label 必填且唯一、to 必须存在 | 233-243 | `去向标签重复` |

**明确不检查**（推断自代码 + 与 `assist-rules.js` 对照）：
- 从 start 到 end 的**可达性**（只查入度，不查能否走到 end）；assist-rules 声称「必须最终走到 end」（`assist-rules.js:29`），但保存期不拦，只在**运行期**因断头/无 default 抛错。
- **环检测**：故意不做（驳回回环合法），靠 `maxRuns` 运行期保护。
- `task.body.prompt` 非空、`body.output` 合法 JSON Schema、`maxRuns` 数值范围 —— 均不校验。
- `displayFrom`（审批页展示上游产物）完全不校验，属于 Client 侧字段（`assist-edits.js:31` 允许 AI 写）。

### 7.3 `validateWorkflowInputs`（`graph.js:34-73`）

`inputs` 缺省/`null` → 通过（老工作流不受影响）；非数组 → 错；每项必须是对象；name 必填、禁非法字符、不重复；type 缺省 `text`，闭集 `{text,file}`；输出归一为 `{name,label,required:bool,type}`。`declaredFileInputs(wf)`（`76-79`）→ 只返回 `type==='file'` 的项，供 Host 做**创建/启动两级校验**与 scheduler 调用方渲染字段。

### 7.4 `prepareWorkflowForSave` / `orderTaskNodesByFlow`

- `prepareWorkflowForSave(workflow, existing)`（`374-383`）：校验失败返回 `{ok:false,errors}`；通过则**原地规范化** `workflow.inputs`、写 `schemaVersion=2`、`revision=(existing?.revision||0)+1`。
- `orderTaskNodesByFlow(workflow)`（`397-432`）：从 `start` 做 BFS（真实边 + human routes 虚拟边），只收录 `task` 节点，得到 `stageStates` 的**展示顺序**；不可达 task 按声明顺序补尾。任务创建时用它生成 `stageStates`（`index.js:1809-1812`）。

### 7.5 Host 里真正被使用的 graph 函数 vs 死导出

| 导出 | 生产调用方 | 结论 |
|---|---|---|
| `validateWorkflow` | `index.js:18`（间接经 `prepareWorkflowForSave`）、`assist-edits.js:22` | ✅ 核心 |
| `prepareWorkflowForSave` / `orderTaskNodesByFlow` / `declaredFileInputs` / `validateWorkflowInputs` | `index.js:18` | ✅ 核心 |
| `nextNode` / `resolveInputs` | 仅 `graph.test.js:8` | ❌ 生产死代码（orchestrator 内联了自己的 `nextNode`；`resolveInputs` 描述的「节点 inputs 映射」运行时根本没用） |
| `deriveRunGraphStates` | 仅 `graph.test.js:448` | ❌ Host 不调用；`client.js:247` 有同名**镜像实现** |
| `routeEdgeKnee` / `roundedOrthoPath` / `smoothCurvePath` / `routeEdge` | 仅 `graph.test.js:529` | ❌ 纯 SVG 几何；`client.js:329,387` 明确写「镜像 graph.js…两处需同步」 |

即：`graph.js` 名义上是「Host 与编排器共用的纯函数」，实际混入了 **Client 渲染算法**——`nextNode / resolveInputs / deriveRunGraphStates / routeEdgeKnee / roundedOrthoPath / smoothCurvePath / routeEdge` 共 7 个导出在 Host 生产链路**无任何调用方**，只服务测试与 `client.js` 的镜像实现。这是本插件最明显的一处职责错位。

---

## 8. 附件 / 文件入参 / 需求：三分工

### 8.1 三个模块的边界

| 模块 | 输入来源 | 键 | 上限 | 物化目标 | 证据 |
|---|---|---|---|---|---|
| `uploads.js` | `POST /uploads` body `{name,dataBase64}` | — | 单文件 32MB；暂存 24h | `<dataRoot>/uploads/<uploadId>/<safeName>` | `uploads.js:17,21,80-102` |
| `attachments.js`（**内置通用附件**，无需声明） | `POST /tasks` body `attachments:[{uploadId,name?}]`（≤20） | **固定键 `inputs.附件`** = 换行拼接的**绝对路径串** | 20 个 | `<cwd>/.knj-inputs/<taskId>/<file>` | `attachments.js:32,34,46-68,95-173` |
| `graph.inputs[type=file]` + `index.js`（**声明式文件入参**） | `fileInputs:{<参数名>:{uploadId}}` 或 `inputs.<参数名>`=路径 | `inputs.<参数名>` = 绝对路径 | 单文件 32MB（暂存期） | 同上 | `index.js:1462-1519` |
| `requirement.js` | `body.description` | `task.description` / `descriptionFile` | 8000 字阈值、6000 字头部 | `<tasksDir>/<taskId>/requirement.md` | `requirement.js:13-17,73-86`、`index.js:1532-1545` |

### 8.2 上传暂存（uploads.js）

- `sanitizeFileName`（`44-59`）：取 basename（`\` 与 `/` 都切）→ 去 `<>:"|?*` 与控制字符 → 去首尾空白/点 → 纯点拒绝 → 超 120 字符保留扩展名截断。
- `stage`（`80-102`）：base64 白名单校验（`83-88`）→ `Buffer.from` → 空文件/超限抛 `UploadError(code)`（`invalid-name / invalid-payload / empty-file / file-too-large`，路由转 400+code）→ 写 `<uploadId>/<name>` → **显式 `utimes` 刷新目录 mtime**（因为「写文件不一定更新目录 mtime」，`98-100`）。
- `resolve`（`108-121`）：`uploadId` 必须匹配 `^up-[a-z0-9]+-[a-z0-9]{8}$`（`25,109`）才允许拼路径；目录内取第一个非点文件。
- `pruneStale`（`138-156`）：只处理 `up-*` 形态目录，按目录 mtime 超 24h 删除；插件启动时清一次（`index.js:2331`），每次上传后顺手清一次（`1723`）。

### 8.3 附件物化（attachments.js）——最值得抄的一段

顺序（`95-173`）：`normalizeAttachmentRefs` → 空则**绝不创建 `inputs.附件` 键**（否则节点会把空串当路径读，`97-101`）→ 校验 `uploads`/`task.cwd` → `mkdir` + `.gitignore('*')` → 逐条 `resolve`（**暂存失效 = 拒绝启动**并报文件名，不静默少文件，`124-128`）→ 同名冲突处理 → `copyFile` + `stat` 验证 → 记录 marker → 拼 `inputs.附件` → 清理 pending（reusable 时保留）。

同名去重逻辑（`134-145`）：

```js
const isOwnPrevious = previousNames.has(safeName) && !seenThisRun.has(safeName);
if (existsSync(dest) && !isOwnPrevious) {
  let index = 2;
  let candidate = join(dir, `${index}-${safeName}`);   // 2-名字.ext / 3-名字.ext
  while (existsSync(candidate)) { index += 1; ... }
  dest = candidate;
}
```

- marker 文件 `.knj-materialized-names.json` 记录「本任务物化过哪些名字」，用于区分两类「目标已存在」：**自己上次运行留下的**（覆盖，避免反复触发堆出 `2-x`、`3-x`）vs **用户本次另选的同名文件**（加序号，绝不覆盖）。
- 失败回滚：本次已写入的文件全部 `rm`，不留半套材料（`159-163`）。
- `attachmentsAreReusable`（scheduler 专用）：物化后**不丢弃暂存、不清 pending**，因为定时任务每次触发要重新物化（`index.js:486-489`、`attachments.js:115,155-157,171-172`）。
- `assertInsideDir`（`73-79`）：即使 sanitize 被绕过也再校验目标真在目录内（`relative`、绝对路径、盘符三重判断），并**导出给测试直接打靶**（注释：public 入口喂不进越界名，否则护栏就是没人验证的死代码）。

### 8.4 声明式文件入参（index.js）

- **创建时**（`POST /tasks`，`1774-1787`）：必填文件入参必须由 `fileInputs`（上传）**或** `inputs.<name>`（路径）满足其一，否则 400。
- **启动前**（`startTask:1165-1169`）三级：
  1. `materializeFileInputs`：上传 → `<cwd>/.knj-inputs/<taskId>/`，同名冲突用 **`<参数名>-<文件名>`** 前缀（与附件的 `<序号>-` 不同，两套约定并存）；`copyFile` 而非 rename（跨盘 EXDEV，`1511-1514`）；成功后 `uploads.discard`。
  2. `materializeAttachments`：见 §8.3。
  3. `resolveAndVerifyFileInputs`（`1462-1484`）：路径型入参按 `task.cwd` 解析绝对路径 + `stat` 校验必须存在，否则**拒绝启动**（「路径引用 = 触发时读当时文件」）。
- 失败语义：物化失败必须**拒绝启动**——「文件入参指向空比启动失败更糟」（`1452-1453` 注释）。

### 8.5 需求（requirement.js）

| 常量 | 值 | 行 |
|---|---|---|
| `INLINE_MAX` | 8000 字符（**按码点** `Array.from`） | 13,23-25 |
| `HEAD_MAX` | 6000 | 15 |
| `REQUIREMENT_FILE_NAME` | `requirement.md` | 17 |

- `normalizeRequirementText`（`31-41`）：剥 BOM/零宽、统一换行、去行尾空白、折叠 3+ 空行、trim。
- `deriveTaskTitle`（`55-61`）：首条非空行 → 去 markdown `#` → 截 50 码点；空则 `未命名任务 MM-DD HH:mm`（标题恒非空）。
- `formatInputDescription`（`73-86`）：≤8000 全文；>8000 → 前 6000 字 + `[…… 省略 N 字。完整需求已落盘：<path> …]`；若无 `descriptionFile` 则提示「未落盘，请向用户确认」。
- 落盘在 `startTask`（`spillRequirementBeforeRun`，`1532-1545`）而非路由：注释明确原实现写在路由里，导致**调度器路径**（不走路由）的长需求不落盘、注入退化为「完整需求未落盘」；改成单点 owner 后 HTTP/调度器/命令/resume/rerun 全入口覆盖。幂等（已有 `descriptionFile` 直接返回）、失败只降级 warn 不阻断启动。

---

## 9. AI 助手（Host 侧）

### 9.1 两个阶段

```
POST /assist (index.js:1677)
  └─ bridge.startAssist (696-748)
       ├─ 同步校验 workflow{nodes,edges} + message → 400
       ├─ requestId = `as-<ts36>-<rand6>`；registry entry {events,done,result,error}
       ├─ _pruneAssistRuns（保留最近 20 条 / 2h，1062-1072）
       └─ 后台 async:
            runAssist (601-690)
              ├─ parent = agents.currentInitiator() ?? roots()[0]；engine = resolveWorkflowEngine
              ├─ prompt = buildAssistPrompt({summary: summarizeWorkflow(wf), history, message})
              ├─ script = readFileSync('assist-script.js')
              ├─ run = engine.start({script, meta:{name:'knj-workflow-assist',...}, args:{prompt}, parent})
              ├─ 监听 workflow/{agent-start,agent-end,log,phase} → emit 过程行
              ├─ await run.result → {reply, edits, childId, elapsedMs}
              └─ finally: 注销 4 个监听器
            └─ applyEdits(workflow, out.edits)  ← Host 是唯一写图权威
               → emit('validate', 生效/被拒数) → entry.result = {reply, workflow, applied, rejected, childId, elapsedMs}
GET /assist/progress?id=&since= → {events:[seq>since], stream?, done, result?, error?}
```

### 9.2 AI 脚本（assist-script.js）

薄壳：`args.prompt` 非空 → `log()` 一条过程台词（`24`）→ 用 **schema 输出**要求 `{reply, edits[]}`（`27-38`，edits 项 `additionalProperties:true`，结构交给 Host 终检）→ `await agent(promptText, {label:'工作流设计助手', schema})` → 无输出显式抛错（`41-44`，与 orchestrator 同教义）→ return。

### 9.3 编辑动作引擎（assist-edits.js）

8 种动作：`add_node / set_node / remove_node / add_edge / set_edge / remove_edge / set_routes / set_meta`（`25-29`）。三层防护：

1. **动作级语义预检** `precheck`（`74-162`）：未知动作；`add_node` type 闭集/id 必填不重复/routes 目标存在；`remove_node` 禁删 start/end；`set_node` 字段白名单 `NODE_PATCH_KEYS`（禁 x/y/id/type，只有 human 能写 routes/approveTo/rejectTo）；`add_edge` 节点存在/禁重复边/禁自环；`remove_edge`/`set_edge` 边存在；`set_routes` 仅 human、≥1 条、label 唯一、to 存在；`set_meta` 白名单（禁改 id）。
2. **应用** `applyOne`（`165-237`）：全部 `clone` 后返回新 wf；`add_node` 无 id 时 `autoNodeId`（英文标题 → `task-<slug>`，冲突加随机后缀；否则 `task-<rand6>`，`39-55`）；`remove_node` 级联删边；`set_node.body` 浅合并。
3. **整批终检**（`276-281`）：`validateWorkflow(current)`；不通过 → **整批回滚**（返回原图深拷贝、`applied=[]`、rejected 追加图错误）。

被拒动作不阻断后续动作（`260-274`），返回 `{workflow, applied[], rejected[{action,reason}]}`。这实现了 README 的「逐条校验 + 坏图不放行」。

### 9.4 规范单一来源（assist-rules.js）

12 节规范文本（图形态/节点选型/task 配置/边与条件/XOR/AND/human/数据流/落盘/运行语义/反模式/推荐模式），`ASSIST_RULES_SECTIONS` 是唯一文字来源，`ASSIST_RULES` 拼接后进 prompt（`164-166`）。注释声明 `assist-rules.test.js` 逐条断言「规范声称的硬约束，validateWorkflow 确实能拦下」——把文档与实现绑定，避免规范漂移。✅（测试文件存在：197 行）
⚠️ 但注释里引用的 `docs/workflow-mechanics.md §7/§7.1`、`docs/workflow-guide.md`、`WORKFLOW-DESIGN.md`、`DESIGN.md` **全部不在仓库**（`assist-rules.js:8-12`；`git ls-files` 只有 `.gitattributes/.gitignore/assets/cordis.patch.yml/lib/package.json/README.md`），见 R12。

### 9.5 助手过程流的采集（Host 侧最“脏活累活”的一段）

`_startAssistStream`（`765-845`）：

- **数据源优先级链**：`readSession(childId).events` → `readSurface(childId).events` → `listEvents(childId)`，读取失败逐级回退（`768-832`）；全失败静默降级只留阶段行。
- **实时通道**：`ctx.on('session/event', …)`，按 `session.id === childId` 过滤；注释给出实测依据「读持久化日志前 162s 无数据、172s 一次性到 1878 条（按批 flush），所以实时性必须来自事件通道，轮询仅兜底」（`797-799`）。
- **去重游标**：`ingest()` 以 `seq/seq0/time0/time` 单调递增过滤（`783-795`），实时与轮询共用游标。
- **轮询兜底**：2s 一次（`835`）；`done` 后 `finalTick()` 补采最后一帧再停（`737-743,838-842`）——否则正文会停在上一次中间态。
- **事件形状兼容**：`_evField` 同时读 `ev.x / ev.payload.x / ev.data.x`（`848-854`）；`_applyAssistEvent`（`901-1045`）处理 `assistant/chunk`（text-delta/reasoning-delta/tool-call-delta）、压缩批 `reasoning-chunks/text-chunks/tool-call-chunks`、`tool/call`、`tool/result`（真实形状是 `message.content[].content[]` 嵌套块）、`assistant/message`（text/reasoning 块 + usage；有游标累加、无游标幂等填充）、turn/step 边界；所有文本 4000 字截断。
- **技巧点**：因为 assist 脚本用 schema 输出，模型**不产生普通 text 块**，而是逐块生成 `structured_output` 工具参数。`_extractReplyText`（`862-874`）从 tool-call 增量 args 里正则截 `"reply":"…"` 的**未闭合 JSON 字符串前缀**，再用 `_decodeJsonStringPrefix`（`877-898`）容错解码（尾部不完整转义直接丢弃），从而把 structured output “伪装”成流式正文。
- **诊断**：`entry.stream.diag = {source,total,types,live,errors}`（`780,792-793,823`）——代码里自带的“为什么没流”证据链。

---

## 10. 风险与妥协（按严重度）

> 标记：**严重** = 功能不可用/数据丢失；**中** = 可观测问题或维护陷阱；**低** = 风格/冗余。

| ID | 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|---|
| **R1** | **严重** | **`/dev-task` 命令注册契约与 DSH 0.2.x 不兼容**。插件传 `{name, description, execute(line)}`，宿主 `CommandDefinition` 要求 **`handler` 必填**且返回 `{kind:'success'|'error'}` | 插件 `index.js:2234-2302`；宿主 `dsh-commands/lib/index.js:153`（缺 handler 抛 `TypeError`）、`184-204`（结果必须是 CommandResult）；宿主 dsh-base 确实挂载了 `commands` 服务（`dsh-base/cordis.patch.yml:317-318`），因此 `ctx.get('commands')` 非空、`registerCommands` 不会提前 return | ✅ 实证（**运行时复现**）：`new CommandRuntime(new Context()).register({name,description,execute})` 抛 `TypeError: command "dev-task" handler must be a function`；`ctx.effect(()=>{throw ...})` 也会**同步重新抛出**（同一复现脚本，cordis `lib/index.js:1249-1262` 逻辑）。后果 ◐：该 throw 从 `store.init().then` 冒泡到 `.catch`（`index.js:2335`）→ 日志出现 “init failed: command "dev-task" handler must be a function”，`/dev-task` 不在斜杠菜单；而 `registerRoutes` 在它之前执行，**HTTP API 仍正常**（与线上数据一致）。建议：改 `handler({rawInput})` + `{kind:'success',text}`。**现有 389 个测试零覆盖此路径**（无任何用例 import `registerCommands` 或断言 `dev-task`），所以测试全绿也发现不了它 |
| **R2** | 中 | **README「编排器参数」与实现脱节**：`args.resumeFrom`/`args.rerunStage` 是双向死契约（Host 传、脚本不读、无调用方传） | `README.md:102-109`；`index.js:1212-1213`；`orchestrator.js` 全文无 resumeFrom/rerunStage | 读者按文档接线会得不到断点行为；真实协议是 `initialResults`+`skipSet`+`decided`+`decision` |
| **R3** | **严重** | **损坏 JSON 静默重置/丢数据**：`readJson` 任何异常返回 fallback；`init()` 见 `workflows.length===0` 就注入默认工作流并写回；`task.json` 损坏 → 该任务在列表/详情中静默消失 | `index.js:66-69,131-141,196-216,217-219` | 一次写坏/手改错逗号 = 全部工作流被默认流水线替换；无备份、无告警。建议：解析失败改名 `.corrupt-<ts>` 并告警 |
| **R4** | 中 | **HTTP API 无鉴权/无 CORS**，且 `GET /diag` 暴露内部 ctx/scope 结构、`GET /tasks/:id/file` 可读 cwd 内任意文本文件（≤200KB，含 realpath 防 symlink 逃逸）、scheduler `stageAttachments` 可读**任意宿主路径**并暂存 | `index.js:1648-1671,2137-2187,431-445` | 依赖 loopback + 同源；本机任意进程可调用；诊断接口不宜长期留 |
| **R5** | 中 | **调试日志无轮转**：每次 `saveTask/mutateTask` 都 `appendFileSync` 一行 JSONL，文件只增不减；且路径硬编码 `~/.dsh/dev-orchestrator/`，**忽略 `DSH_HOME` 与 `config.dataRoot`** | `index.js:35-44`（35-36 路径）、`226,229,233,245,251,256` | 实测 **3,131,693 B / 24,927 行**（自 2026-09-02 至今，仍在增长）；同步 IO 挂在事件热路径；与 dataRoot 配置不一致 |
| **R6** | 中 | `/models` **手写 YAML 缩进解析器**，只认 `agent-default-model` 与 `llm-pi-ai.providers[].models[].id`，且候选路径硬编码 | `index.js:1605-1646`（候选 1617-1619，解析 1623-1643） | 宿主配置结构一变 → 静默返回空列表，新建任务下拉只剩“继承当前会话”；注释承认这是为了绕开「Host 插件 realm 拿不到 llm 服务」 |
| **R7** | 中 | 工作流保存校验失败抛普通 `Error` → 路由 500（应为 400），客户端拿不到结构化 errors | `index.js:157`（throw）、`1700-1709`（无 try/catch）、`2204-2207`（默认 500） | 「图里有错」被当成服务端故障；错误信息只能从 message 里看 |
| **R8** | 中 | **断点双写 + 目录在 home**：orchestrator 仍指示 subagent `write` 到 `<dataRoot>/tasks/<id>/stages/<node>.json`（家目录，subagent 未必可写），Host 又通过 checkpoint 日志写同一路径 | `orchestrator.js:301,326`；`index.js:1302-1313` | prompt 里这段指令基本是噪声（作者注释已承认 subagent 不遵守）；若真的写成功还可能与 Host 写竞争同一文件 |
| **R9** | 中 | **graph.js 混入客户端渲染算法，且 client.js 有 3 处镜像实现**（注释要求“两处需同步”），Host 生产链路只用到 5 个导出（`validateWorkflow` + `prepareWorkflowForSave/orderTaskNodesByFlow/declaredFileInputs/validateWorkflowInputs`） | `graph.js:498-638`；`client.js:247,329,385`；`graph.test.js:448,529` | 双份算法漂移风险；Host 包体变大；`nextNode/resolveInputs` 是纯死代码 |
| **R10** | 低 | `index.d.ts` 与实现漂移：`KnjWorkflowScheduledTaskInput` 缺 `fileInputs/pathInputs/attachments/attachmentsAreReusable`（实现 `index.js:447`）；`createKnjWorkflowSchedulerService` 的 `store/bridge` 都是 `any`；运行时额外导出的 `MAX_BODY_BYTES/readBody/registerRoutes/DevTaskStore/WorkflowBridge` 未出现在 d.ts | `index.d.ts:6-23` vs `index.js:407-536` | TS/服务消费方只能 `any` |
| **R11** | 低 | **测试文件随包发布**：`files:["lib"]` 把 23 个 `*.test.js`（合计 6,982 行）+ 2 个 `*.mjs` repro 脚本打进 tarball | `package.json:37-41`；实测 tgz 251,321 B / 40 个文件（= 37 个 lib 文件 + patch + package.json + README），其中 23 个 `*.test.js` | node_modules 里多出测试与可执行 repro 脚本；`pnpm pack` 无 `files` 白名单细化 |
| **R12** | 低 | **文档全部断链**：README 链接 `DESIGN.md`、`design/task-attachments.md`；代码注释引用 `WORKFLOW-DESIGN.md`、`docs/workflow-mechanics.md`、`docs/workflow-guide.md`、`design/new-task-requirement-input.md` —— 仓库里一个都没有 | `README.md:5,13-15`；`graph.js:8`；`requirement.js:4`；`assist-rules.js:9-12` | 读者（含本报告读者）无法看到设计依据；本次逆向只能靠代码与注释 |
| **R13** | 低 | `writeStage/saveResults` 绕过 per-task 队列（不同文件 + 原子写，风险低但语义不一致） | `index.js:266-274` vs `241-258` | 同一 stage 并发写时后写覆盖（正常单 run 不会并发） |
| **R14** | 低 | `listTasks` 每 3s 轮询时**串行读全部 task.json**（O(N) IO），关键词过滤在内存拼串；列表项仍带 `stageStates`（体积随节点数增长） | `index.js:196-216` | 任务多时看板轮询延迟线性增长 |
| **R15** | 低 | `Config` 无校验：`httpPrefix` 不强制前导 `/`、`orchestratorScript` 是**脚本源码**不是路径（文档未写）；`dataRoot` 空串才用默认 | `index.js:48-52,1197,2309-2310` | 配错前缀 → 路由静默 404 |
| **R16** | 低 | 死属性/死分支：`this.assistScript` 永不赋值（永远走 readFileSync）；`this.listeners` 只写不读；`opts.resumeFrom/rerunStage` 无调用方 | `index.js:582,627,1222,1350,1212-1213` | 维护噪声 |
| **R17** | 低 | 默认工作流在 `workflows.length===0` 时**复活**；`deleteWorkflow` 后重启即回填 | `index.js:136-138,167-173` | 用户“删干净”的意图被覆盖 |
| **R18** | 低 | `finalizeTask` 的 paused 分支保留旧 `error` 不清；`cancel` 分支把 running 标 done（有意，但 cancelled 任务看起来像完成） | `index.js:1396-1407,1424-1428` | UI 语义细节 |
| **R19** | 低 | `maxRuns` 按**单次 run** 计数，resume 后清零 → 反复「继续」可以无限重试，不会触发死循环保护 | `orchestrator.js:33,47-59` | 与「唯一防死循环机制」的表述有差距（单 run 内成立） |
| **R20** | 低 | `GET /tasks/:id` 对缺快照任务**注入 fallback 到响应对象**（不落盘），并靠 `workflowSnapshotFallback` 提示；若工作流已删则仍无图 | `index.js:1746-1752` | 历史任务（调度器旧版）体验缺口 |

---

## 11. 未解之谜（明确未验证）

| # | 问题 | 为什么没结论 | 建议验证方式 |
|---|---|---|---|
| U1 | 本机运行中的 dsh web 是否**真的打印**了 `init failed: command "dev-task" handler must be a function`？ | 抛错链路已运行时复现（见 R1），但宿主日志未落盘（`~/.dsh` 下无 host 日志文件），无法确认该实例实际执行路径 | 重启 `dsh web` 看 stderr；或在斜杠菜单输入 `/dev` 看是否出现 `dev-task` |
| U2 | `workflow/*` 事件在**插件 root ctx** 上是否全部可见（还是只对 run 所属 scope 可见）？ | 会话/工作流事件带 scope 语义（`Scoped<Session>`），本次未跑运行时实验 | 用一个最小插件注册 `ctx.on('workflow/phase')` 打印，跑一次任务 |
| U3 | `session/event` 在 root ctx 的派发范围（assist 实时流是否真能收到） | 同上；代码注释称“实测有效”，但未在本机复验 | 触发一次 `/assist`，对比 `stream.diag.live` 是否 > 0 |
| U4 | `run.dispose()` 与 `parentHandle.dispose()` 的 `machine.whenIdle()` 契约（注释称不 dispose 会 hang） | 引擎内部实现未读 | 读 `dsh-workflow` 的 run 实现；或观察 `knj-task-*` root agent 是否泄漏 |
| U5 | 并行分支内 human 被保存期拦截，但**嵌套并行**、多 join、split 分支交叉的真实运行语义 | assist-rules 声明「不支持嵌套并行」，validateWorkflow 只做一层 findJoin 分析 | 构造嵌套并行图跑 orchestrator 单测 |
| U6 | `dsh-scheduler` 消费 `knjWorkflowScheduler` 的真实契约（本机未安装 dsh-scheduler） | 无宿主包可读 | 安装后读其调用点；当前只能以 `index.d.ts:19-23` 为准（且已知漂移） |
| U7 | Client 侧如何渲染 `deriveRunGraphStates` / 审批卡 / 会话跳转 | 他队负责（client.js 4293 行） | 见 client 侧逆向报告 |
| U8 | `workflows.json` 中 x/y 坐标的写入者（Host 只存不造）与导入导出 id 冲突提示的完整链路 | 属 Client；Host 的 `saveWorkflow` 是静默 upsert（`index.js:153-166`），冲突提示在 `client.js:920,1251,3475` | 见 client 侧报告 |
| U9 | `attachmentsAreReusable` 的重复触发链路是否真的不重复堆积文件 | 需要调度器配合才能跑到 | `index.test.js:586` 只有 1 个 `materializeAttachments` 穿越名用例；建议补「调度器连续两次触发」场景 |

---

## 12. 复现与取证命令（只读）

```powershell
# 1) 行数（总行 vs 非空行）
(Get-Content lib/index.js -Encoding UTF8).Count            # 2338
tar -xOzf dsh-knj-workflow-2026.10.218.tgz package/lib/index.js | Measure-Object -Line   # 2260（非空）

# 2) 工作区源码 == 已发布包（逐行 diff，应为 0）
$raw = tar -xOzf dsh-knj-workflow-2026.10.218.tgz package/lib/index.js
$tgz = ($raw -join "`n") -split "`r?`n"; $cur = Get-Content lib/index.js -Encoding UTF8
(Compare-Object $tgz $cur).Count   # 0

# 3) Host 路由清单（24 条）
Select-String -Path lib/index.js -Pattern "^\s*\['(GET|POST|PUT|DELETE)', '" -Encoding UTF8

# 4) 活数据落地形态
Get-ChildItem "$env:USERPROFILE\.dsh\dev-orchestrator" -Force
Get-Content "$env:USERPROFILE\.dsh\dev-orchestrator\tasks\<taskId>\task.json" -Encoding UTF8

# 5) 宿主契约核对（示例：commands）——含运行时最小复现
Select-String -Path "<dsh>/node_modules/@deepseek-ai/dsh-commands/lib/index.js" -Pattern 'handler must be a function|normalizeDefinition'
# 运行时（只读、不写文件）：
#   node --input-type=module -e "import { Context } from '@deepseek-ai/cordis';
#     import { CommandRuntime } from 'file:///<dsh>/node_modules/@deepseek-ai/dsh-commands/lib/index.js';
#     new CommandRuntime(new Context()).register({name:'dev-task',description:'x',execute(){}});"
#   → TypeError: command "dev-task" handler must be a function

# 6) 测试套件（本报告撰写时实跑，Node v24.12.0；只读、git status 无变化）
node --test "lib/*.test.js"
#   → tests 389 / pass 389 / fail 0 / cancelled 0 / skipped 0 / duration ≈3.76s / exit 0
#   （注：`node --test lib/` 在 Node 24 只会把目录当单个条目跑 1 个“test”，必须用 glob）
#   覆盖缺口：全部 389 个用例中没有任何一条引用 registerCommands / dev-task / commands，
#   所以 R1 的命令注册回归在现有测试下永远绿。
```

### 12.1 测试套件现状（green gate 记录）

| 项 | 结果 |
|---|---|
| 命令 | `node --test "lib/*.test.js"`（Node v24.12.0） |
| 用例 | **389 tests / 389 pass / 0 fail / 0 cancelled / 0 skipped** |
| 退出码 | 0（耗时 ≈3.76s） |
| 工作区洁净 | 运行前后 `git status --porcelain` 完全一致（测试用 `mkdtemp` 临时目录，不污染仓库） |
| 历史对照 | 与 `reo/tmp/test-all.log`（上一轮记录：389/389 pass，3.93s）一致 → 无回归 |
| **覆盖缺口** | 23 个测试文件**从不 import/调用 `registerCommands`**，也没有 `dev-task` 断言（grep 0 命中）→ R1 这类宿主契约回归在现有套件下是盲区；同样无 scheduler 服务契约测试（U6） |

**未修改任何文件**；`lib/`、`package.json`、`cordis.patch.yml`、`README.md` 均只读；除 `reo/findings/host.md` 外未写入工作区。
