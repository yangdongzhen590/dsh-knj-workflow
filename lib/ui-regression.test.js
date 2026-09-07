/**
 * dsh-knj-workflow UI 文案/交互回归测试（node:test，零依赖）
 * 覆盖（对应最近一轮 UI 优化验收）：
 *  - 页签名：「任务」→「流程运行」、「工作流」→「流程设计」（WorkbenchView 主看板 + 旧 Overlay + 侧边栏入口）
 *  - 流程运行（任务 tab）按钮布局参考流程设计：列表头部出现「共 N 个任务」计数行，动作按钮成组右对齐
 *  - 流程设计列表：点击标题（.knj-item-title）进入编辑页面
 * 运行：node --test lib/ui-regression.test.js
 *
 * 说明：client.js 是浏览器 bundle（window.__ModuleLoader__.load 包装），无构建链、
 * 直接维护 lib/ 产物；UI 行为（React 组件）不在纯函数测试范围内，这里对产物源码做
 * 结构断言，保证「改名/加行/加交互」后不回归。改 UI 时若命中断言，需同步更新本文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dirname, 'client.js'), 'utf8');

// ---- 调度器工作流任务直达 ----

test('UI：接收调度器工作流任务事件并打开指定流程任务详情', () => {
  assert.match(src, /dsh-knj-workflow:open-task/);
  assert.match(src, /api\('\/tasks\/' \+ taskId\)/);
  assert.match(src, /openDevBoard\(\)/);
  assert.match(src, /pendingScheduledWorkflowTask/);
  assert.match(src, /this\.openTaskDetail\(pendingScheduledWorkflowTask\)/);
});

// ---- 页签名 ----

test('UI：主看板（WorkbenchView）两个页签命名为「流程运行」/「流程设计」', () => {
  // knj-wb-tab 的任务/工作流两个页签
  assert.match(src, /knj-wb-tab' \+ \(tab === 'tasks' \? ' on' : ''\), onClick: \(\) => this\.setState\(\{ tab: 'tasks' \}\) \}, '流程运行'/);
  assert.match(src, /knj-wb-tab' \+ \(tab === 'workflows' \? ' on' : ''\), onClick: \(\) => this\.setState\(\{ tab: 'workflows' \}\) \}, '流程设计'/);
});

test('UI：旧 Overlay 两个页签同步命名为「流程运行」/「流程设计」', () => {
  assert.match(src, /knj-tab' \+ \(tab === 'tasks' \? ' on' : ''\), onClick: \(\) => this\.setState\(\{ tab: 'tasks' \}\) \}, '流程运行'/);
  assert.match(src, /knj-tab' \+ \(tab === 'workflows' \? ' on' : ''\), onClick: \(\) => this\.setState\(\{ tab: 'workflows' \}\) \}, '流程设计'/);
});

test('UI：左侧栏入口文案/无障碍属性为「流程设计」', () => {
  assert.match(src, /entry\.setAttribute\('aria-label', '流程设计'\)/);
  assert.match(src, /entry\.setAttribute\('title', '打开流程设计看板/);
  assert.match(src, /overflow:hidden">流程设计<\/span>/);
});

// ---- 流程运行（任务 tab）按钮布局参考流程设计 ----

test('UI：流程运行（任务 tab）列表头部出现「共 N 个任务」计数行（对齐流程设计列表头）', () => {
  assert.match(src, /`共 \$\{tasks\.length\} 个任务`/);
});

test('UI：流程运行头部按钮成组右对齐（归档 + 新建任务，gap 6，与流程设计列表头同款）', () => {
  // 任务 tab 内容区的动作按钮组：归档 + 新建任务，与 SidebarWorkflowsTab 列表头（gap:6/marginBottom:0）一致
  const taskActions = src.match(/'归档', react\.createElement\('span', \{ style: \{ fontSize: 11, opacity: \.7 \} \}, `\(\$\{archived\.length\}\)`\)\),\s*react\.createElement\('button', \{ className: 'knj-btn primary', onClick: \(\) => openNewTaskModal\(\) \}, icon\('plus'\), '新建任务'\)/);
  assert.ok(taskActions, '任务 tab 头部应含「归档 (N) + 新建任务」成组按钮');
  // 组容器与流程设计列表头同款：gap 6 / marginBottom 0
  // 用 indexOf 取 WorkbenchView 任务 tab 的第一处（SidebarTasksTab 是遗留死代码，gap 8 不算数）
  const firstCount = src.indexOf('共 ${tasks.length} 个任务');
  const groupCtx = src.slice(Math.max(0, firstCount - 400), firstCount + 900);
  assert.match(groupCtx, /gap: 6, marginBottom: 0/);
});

test('UI：流程运行头部不再把「新建任务」堆在主看板顶栏（已移入列表头部组）', () => {
  // WorkbenchView 顶栏（knj-board-head 内）不应再有无条件的新建任务按钮；
  // 新建任务按钮只出现在任务 tab 内容区的列表头（openNewTaskModal 调用点唯一化由上面两条保证）。
  const boardHead = src.slice(src.indexOf("const head = react.createElement('div', { className: 'knj-board-head' }"), src.indexOf('let body;'));
  assert.ok(!boardHead.includes("openNewTaskModal()"), '主看板顶栏不应再直接渲染新建任务按钮');
});

// ---- 流程设计列表标题点击进编辑 ----

test('UI：流程设计列表点击标题（.knj-item-title）进入编辑页面', () => {
  assert.match(src, /className: 'knj-item-title', title: '点击进入编辑', onClick: \(\) => this\.setState\(\{ editing: w \}\) \}, w\.name/);
});

// ---- 画布编辑器：切换选中节点时属性面板必须重建（bug：编码框残留上一节点编码）----

test('UI：节点属性面板根元素以 node.id 为 key（切换节点时整树重建，defaultValue 控件不残留）', () => {
  assert.match(src, /return react\.createElement\('div', \{ key: node\.id, className: 'knj-ge-props-inner' \},/);
});

test('UI：修改节点编码成功后同步 selectedId（避免选中节点"失联"导致面板闪空）', () => {
  assert.match(src, /selectedId: this\.state\.selectedId === oldId \? newId : this\.state\.selectedId/);
});

// ---- 人工审批文件/目录预览（file/dir 输出类型 + displayFrom 双模式 + openPreview）----

test('UI：输出字段类型下拉提供 file / dir（审批按类型渲染为文件入口）', () => {
  assert.match(src, /\{ value: 'file' \}, 'file'/);
  assert.match(src, /\{ value: 'dir' \}, 'dir'/);
});

test('UI：审批卡支持 openPreview（文件路径 displayFrom 直开 + file/dir 字段预览）', () => {
  assert.match(src, /async openPreview\(path, label, scope = 'human'\)/);
  assert.match(src, /looksLikePathStr\(displayFrom\)/); // displayFrom 双模式：节点 id / 文件路径
  assert.match(src, /renderMarkdown\(/); // md 简易渲染
  assert.match(src, /isDir: !!r\.isDir, entries: r\.entries/); // Host 目录返回接入
});

test('UI：审批展示产物中 file/dir 类型字段整行可点击（点名称即预览，无独立按钮）', () => {
  assert.match(src, /\(t === 'file' \|\| t === 'dir'\) && typeof v === 'string'/);
  assert.match(src, /role: 'button', tabIndex: 0/); // 名称行作为可点击元素
  assert.match(src, /f\.isDir \|\| !this\.tryOpenSidebar\(f\.value, f\.key\)/); // 文件→侧栏预览，目录→内嵌浏览
});

test('UI：审批预览优先接入 dsh-better-sidebar（tryOpenSidebar 同步 openTab editor，失败回退内嵌）', () => {
  assert.match(src, /tryOpenSidebar\(path, label\)/);
  assert.match(src, /_ctx && _ctx\.get \? _ctx\.get\('betterSidebar'\) : null/); // 动态取 betterSidebar 服务，未装时回退
  assert.match(src, /type: 'editor', path: abs/); // 打开内置 editor tab（md/图片/PDF/代码现成渲染）
  assert.match(src, /if \(!this\.tryOpenSidebar\(displayFrom, displayFrom\)\)/); // 路径直开按钮接入
  assert.match(src, /f\.isDir \|\| !this\.tryOpenSidebar\(f\.value, f\.key\)/); // file/dir 字段按钮接入
  assert.match(src, /e\.isDir \|\| !this\.tryOpenSidebar\(e\.path, e\.name\)/); // 目录条目「查看」接入
});

test('UI：任务详情支持「运行效果图」视图（流程图/列表切换 + SVG 画布 + 点击节点详情）', () => {
  assert.match(src, /viewMode: 'graph'/); // 默认流程图模式
  assert.match(src, /流程进度（\$\{steps\.length\}）/); // 进度区保留计数
  assert.match(src, /renderRunCanvas\(\)/); // 画布渲染方法存在
  assert.match(src, /runSvgNode\(n, status, typeColor, zoom\)/); // 节点 SVG（类型定底 + 状态）
  assert.match(src, /arrowShape\(route\.ax, route\.ay, route\.dx, route\.dy/); // 连线末端手工画箭头（可靠尺寸）
  assert.match(src, /graphZoom/); // 缩放/适应控件
  assert.match(src, /viewBox: `0 0 \$\{W\} \$\{H\}`/); // 缩放时 viewBox 保留完整坐标系，禁止裁掉右/下流程节点
  assert.match(src, /preserveAspectRatio: 'xMinYMin meet'/); // 从左上完整适配画布
  assert.match(src, /startRunCanvasPan\(e\)/); // 空白区域按住拖动画布
  assert.match(src, /scrollLeft = this\._runPan\.left - dx/); // 拖动实际平移原生滚动视口
  assert.match(src, /cursor: 'grab'/); // 视觉提示可拖
  assert.match(src, /onMouseDown: \(e\) => e\.stopPropagation\(\)/); // 节点点击不触发画布拖动
  assert.match(src, /width:min\(1280px,96vw\);max-height:92vh/); // 工作台弹窗扩容
  assert.match(src, /this\.renderRunCanvas\(\)/); // 流程进度区在 graph 模式渲染画布
  assert.match(src, /steps\.map\(\(s, i\) => this\.renderNodeCard/); // 列表模式保留原卡片
});

test('UI：子会话查看在点击时动态获取 sessions 服务（避免 apply 初始 null 永久缓存）', () => {
  assert.match(src, /function getSessionsService\(\)/);
  assert.match(src, /_ctx\?\.get\?\.\('sessions'\) \|\| _sessions/);
  assert.match(src, /const sessions = getSessionsService\(\)/);
  assert.match(src, /sessions\.open\(childId\)/);
  assert.match(src, /sessions\.refreshSubagents\(task\.parentSessionId\)/);
});

test('UI：运行态状态推导与状态色表存在（镜像 graph.js deriveRunGraphStates）', () => {
  assert.match(src, /function knjDeriveRunStates\(task\)/); // 客户端推导（human/gateway/start/end 补全）
  assert.match(src, /waiting: \{ label: '人工待审'/); // 展示态：人工待审
  assert.match(src, /passed: \{ label: '已执行'/); // 展示态：已过（start/gateway）
  assert.match(src, /renderGraphDetail\(\)/); // 点节点详情（含产物/错误/重跑/子会话）
  assert.match(src, /loadStageResult\(stageId\)/); // 详情懒加载 stage 产物
});

test('UI：连线正交避让路由存在（routeEdge + flowObstacles，编排画布与运行图共用）', () => {
  assert.match(src, /function routeEdge\(sx, sy, tx, ty, obstacles/); // 避让路由（镜像 graph.js）
  assert.match(src, /function flowObstacles\(nodes, fromId, toId\)/); // 障碍卡（端点除外 + 留白）
  assert.match(src, /function flowPorts\(f, t(?:, slot)?/); // 进出端口按目标方向与入边槽位选择（汇聚箭头不重叠）
  assert.match(src, /routeEdge\(sx, sy, tx, ty, flowObstacles\(wf\.nodes/); // 编排画布接线（普通边 + human 边）
  assert.match(src, /routeEdge\(sx, sy, tx, ty, flowObstacles\(nodes, ln\.from, ln\.to\), 13\)/); // 运行图接线 + 箭头尾部回缩
});
