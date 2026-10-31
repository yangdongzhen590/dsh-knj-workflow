/**
 * dsh-knj-workflow 客户端纯逻辑与渲染的**行为级**测试（node:test）
 *
 * 背景：lib/ui-regression.test.js 全部是「读 client.js 源码 + 正则断言」，对运行期缺陷
 * （渲染期未定义变量、事件处理器里的未绑定标识符）完全不敏感——实测：严重缺陷能在 300+ 项
 * 全绿下存活。所以本文件把 client.js 里**真实的产物代码**抽出来执行：
 *   1. `KanbanView`：真跑 `render()` 并**实际触发**「拖回待执行」的 `onDrop()`
 *   2. `NewTaskModal` 类：真跑 `render()`，覆盖多个状态分支（含文件入参的未选/上传中/已选）
 *   3. `SidebarTaskDetail.renderRequirement()`：折叠 / 展开 / 无描述 / 带 descriptionFile
 *   4. `SidebarTaskDetail.renderTaskInputValues()`：文件入参显示落盘路径
 *   5. `SidebarTaskDetail.renderHumanCard()`：缺 `workflowSnapshot` 的历史任务（曾白屏）+ 配了去向
 *
 * 覆盖边界（不冒称）：只执行上述 `render()` 与其调用的渲染方法及 `onDrop`；**不覆盖**
 * 生命周期、其余事件处理器（`selectFileInput`/`onSearchChange`/`submit`/`autoGrow`）、
 * DOM 布局与样式——那部分靠人工硬刷新验收（见 tasks.md §7.9）。
 * 抽取靠 client.js 内的「抽取区」注释标记；标记缺失时本文件必须失败，不得静默跳过。
 *
 * 非空性：执行级用例都用变异测试证伪过（红数矩阵见 tasks.md §7.5）。
 *
 * 运行：node --test lib/requirement-import-ui.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dirname, 'client.js'), 'utf8');

// ---------------------------------------------------------------------------
// 看板：抽取真实 KanbanView，**执行 render() 并真的触发"拖回待执行"的 onDrop**
//
// 这条历史缺陷（把 props.tasks 改名 list 后 onDrop 里还剩裸 tasks → ReferenceError，整条
// "失败任务续跑"入口静默死亡）此前只受源码正则保护，而正则恰恰是已经失败过两次的那类门禁。
// ---------------------------------------------------------------------------

/** 抽取 KanbanView 类源码并编译（依赖以桩注入；只覆盖本类自己的渲染与拖拽逻辑）。 */
function loadKanbanView() {
  const a = src.indexOf('class KanbanView');
  const b = src.indexOf('/** 表格形态', a);
  assert.ok(a > 0 && b > a, '应能定位 KanbanView 源码段');
  const deps = {
    react: makeReactStub(),
    api: async () => ({}),
    toast: () => {},
    icon: () => null,
    BOARD_COLUMNS: [
      { key: 'pending', label: '待执行', hint: '排队', statuses: ['pending'], color: '#888' },
      { key: 'failed', label: '失败', hint: '可拖回', statuses: ['failed', 'cancelled'], color: '#f00' },
    ],
    FAILED_KEYS: new Set(['failed', 'cancelled']),
    STATUS_META: { pending: { label: '待执行', color: '#888' }, failed: { label: '失败', color: '#f00' } },
    boardStageText: () => '',
    progressPct: () => 0,
    fmtAgo: () => '',
  };
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${src.slice(a, b)}\nreturn KanbanView;`);
  return factory(...names.map((n) => deps[n]));
}

test('KanbanView：拖「失败」卡片到「待执行」列必须弹出确认（onDrop 不得引用未绑定变量）', () => {
  const KanbanView = loadKanbanView();
  const tasks = [{ id: 'task-1', status: 'failed', title: '失败的任务', stageStates: [] }];
  const inst = new KanbanView({ tasks, onOpenDetail: () => {}, onChanged: () => {} });

  let tree;
  assert.doesNotThrow(() => { tree = inst.render(); }, 'KanbanView.render() 抛错会让整个看板空掉');
  const pendingCol = flatten(tree).els.find((e) => e.props && e.props['data-col'] === 'pending');
  assert.ok(pendingCol, '应有 pending 列（拖拽落点）');
  assert.equal(typeof pendingCol.props.onDrop, 'function', 'pending 列应有 onDrop');

  const ev = { preventDefault() {}, dataTransfer: { getData: () => 'task-1', setData() {}, effectAllowed: '', dropEffect: '' } };
  assert.doesNotThrow(() => pendingCol.props.onDrop(ev), 'onDrop 抛错 = 拖回待执行静默失效（历史缺陷）');
  assert.equal(inst.state.confirmId, 'task-1', 'onDrop 必须设置 confirmId（否则确认框永不出现）');
  assert.ok(flatten(inst.render()).texts.some((t) => t.includes('移回待执行')), '确认框应渲染出来');
});

test('KanbanView：非失败卡片拖回不弹确认（避免误操作）', () => {
  const KanbanView = loadKanbanView();
  const inst = new KanbanView({ tasks: [{ id: 'task-2', status: 'success', title: '已完成', stageStates: [] }], onOpenDetail: () => {}, onChanged: () => {} });
  const pendingCol = flatten(inst.render()).els.find((e) => e.props && e.props['data-col'] === 'pending');
  pendingCol.props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => 'task-2' } });
  assert.equal(inst.state.confirmId, null, '只有失败/已取消的任务才需要确认框');
});


// ---------------------------------------------------------------------------
// 新建任务弹窗：抽取真实类并**执行 render()**
//
// 为什么必须执行而不是断言源码：本项目已两次栽在「渲染期引用了未解构/未绑定的变量」上
// （KanbanView 裸 tasks、NewTaskModal 裸 importing），两次都能在源码正则全绿的情况下存活，
// 而真实表现是弹窗一闪即消失（React 渲染期抛错会卸载整棵树）。这里用桩 react 真正调用
// render()，把该类缺陷挡在提交之前。
// 覆盖边界：只执行 render() 及其调用的渲染方法（不覆盖生命周期/事件/DOM 布局——那部分靠人工硬刷新验收）。
// ---------------------------------------------------------------------------

/** 最小 react 桩：createElement 产出可遍历的普通对象树，Component 提供 props/state/setState。 */
function makeReactStub() {
  class Component {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(patch, cb) {
      const next = typeof patch === 'function' ? patch(this.state) : patch;
      this.state = { ...this.state, ...next };
      if (typeof cb === 'function') cb();
    }
  }
  return {
    Component,
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  };
}

/** 抽取 client.js 中的 NewTaskModal 真实源码并编译成可实例化的类。
 *  overrides 可替换依赖（如 api / FileReader），用于**执行**上传等事件处理器。 */
function loadNewTaskModal(overrides = {}) {
  const a = src.indexOf('// —— 新建任务弹窗（测试抽取区');
  const b = src.indexOf('// —— 弹窗抽取区结束 ——');
  assert.ok(a > 0 && b > a,
    'client.js 应保留「新建任务弹窗」抽取区标记（本测试据此执行真实 render()；标记缺失必须失败，不得静默跳过）');
  const code = src.slice(a, b);
  assert.match(code, /class NewTaskModal extends react\.Component \{/, '抽取区应包含 NewTaskModal 类');

  const deps = {
    react: makeReactStub(),
    api: async () => ({}),
    toast: () => {},
    icon: () => null,
    openDevBoard: () => {},
    fmtChars: (n) => Number(n || 0).toLocaleString('en-US'),
    fmtBytes: (n) => String(n) + ' B',
    FILE_INPUT_MAX_BYTES: 32 * 1024 * 1024,
    REQ_INLINE_MAX: 8000,
    ATTACHMENTS_MAX: 20,
    ATTACHMENTS_INPUT_NAME: '附件',
    _ctx: undefined,
    _workspaces: null,
    FileReader: globalThis.FileReader,
    ...overrides,
  };
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${code}\nreturn NewTaskModal;`);
  return factory(...names.map((n) => deps[n]));
}

/** 把 render() 产出的元素树摊平，便于断言文本与控件。 */
function flatten(node, acc = { texts: [], els: [] }) {
  if (node == null || node === true || node === false) return acc;
  if (Array.isArray(node)) { for (const n of node) flatten(n, acc); return acc; }
  if (typeof node === 'string' || typeof node === 'number') { acc.texts.push(String(node)); return acc; }
  if (typeof node === 'object') {
    acc.els.push(node);
    flatten(node.children, acc);
  }
  return acc;
}

/** 声明了必填文件入参 doc 的工作流（表单渲染文件选择器的依据）。 */
const WF_WITH_FILE = { id: 'wf-file', name: 'WF', inputs: [{ name: 'doc', label: '需求文档', required: true, type: 'file' }] };

const MODAL_STATES = [
  ['初始（加载中）', {}],
  ['文件入参：未选择', { workflows: [WF_WITH_FILE], workflowId: 'wf-file' }],
  ['文件入参：上传中', { workflows: [WF_WITH_FILE], workflowId: 'wf-file', uploading: { doc: true } }],
  ['文件入参：已选择', { workflows: [WF_WITH_FILE], workflowId: 'wf-file', fileInputs: { doc: { uploadId: 'up-abc-12345678', name: '需求.docx', size: 2048 } } }],
  ['放大编辑覆盖层', { fullEditor: true }],
  ['超阈值长文本', { description: '长'.repeat(9000) }],
  ['无工作流 + 加载失败', { workflows: [], workflowId: '', error: 'boom' }],
  // 覆盖剩余渲染分支：文本入参 / 模型下拉有候选 / 工作目录下拉有候选 / storyCode / 选中模型
  ['全字段已填充', {
    workflows: [{ id: 'wf1', name: 'WF', inputs: [{ name: 'p', label: '参数', required: true }] }],
    models: [{ provider: 'prov', model: 'mdl' }],
    cwdOptions: [{ path: 'D:/ws', title: 'ws' }],
    cwd: 'D:/ws', storyCode: 'US-1', inputs: { p: 'v' }, model: 'mdl', provider: 'prov',
    description: '需求', fullEditor: false,
  }],
];

test('NewTaskModal.render()：所有状态都必须渲染完成（渲染期抛错会让弹窗一闪即消失）', () => {
  const NewTaskModal = loadNewTaskModal();
  for (const [name, patch] of MODAL_STATES) {
    const inst = new NewTaskModal({ onClose: () => {} });
    Object.assign(inst.state, { workflowId: 'wf1', ...patch });
    let tree;
    assert.doesNotThrow(() => { tree = inst.render(); }, `状态「${name}」下 render() 抛错（弹窗会直接消失）`);
    assert.ok(tree, `状态「${name}」应返回元素树`);
    const { texts } = flatten(tree);
    assert.ok(texts.some((t) => t.includes('需求描述（可选）')), `状态「${name}」应含需求描述标签`);
  }
});

test('NewTaskModal.render()：描述为空也可提交（非必填），且不含标题输入框', () => {
  const NewTaskModal = loadNewTaskModal();
  const inst = new NewTaskModal({ onClose: () => {} });
  Object.assign(inst.state, { workflowId: 'wf1' });
  const { els } = flatten(inst.render());

  const submit = els.find((e) => e.type === 'button' && e.children.some((c) => c === '创建并启动'));
  assert.ok(submit, '应有「创建并启动」按钮');
  assert.equal(submit.props.disabled, false, '描述为空时按钮不得被禁用（需求描述已改为可选）');

  const titleInput = els.find((e) => e.type === 'input' && String(e.props.placeholder || '').includes('自动总结'));
  assert.equal(titleInput, undefined, '标题输入框应已移除（标题由 Host 派生）');
});

test('NewTaskModal.render()：每个状态分支都有各自的结构断言（避免"统一断言"掩盖分支内回归）', () => {
  const NewTaskModal = loadNewTaskModal();
  const render = (patch) => {
    const inst = new NewTaskModal({ onClose: () => {} });
    Object.assign(inst.state, { workflowId: 'wf1', ...patch });
    return flatten(inst.render());
  };
  const btn = (t, label) => t.els.find((e) => e.type === 'button' && e.children.some((c) => c === label));

  // 文件入参：未选择 → 「选择文件」可用；上传中 → 按钮禁用且显示「上传中…」；已选择 → 显示文件名/大小与「重新选择」「清除」
  const none = render({ workflows: [WF_WITH_FILE], workflowId: 'wf-file' });
  assert.ok(none.texts.includes('未选择文件'), '未选择时应提示未选择');
  const pickBtn = btn(none, '选择文件');
  assert.ok(pickBtn, '应有「选择文件」按钮');
  assert.notEqual(pickBtn.props.disabled, true, '未上传时「选择文件」应可用');
  assert.equal(none.els.filter((e) => e.type === 'input' && e.props.type === 'file').length, 2,
    '应有两个文件选择器：声明式文件入参（本工作流声明了 doc）+ 内置通用附件');

  const up = render({ workflows: [WF_WITH_FILE], workflowId: 'wf-file', uploading: { doc: true } });
  const upBtn = btn(up, '上传中…');
  assert.ok(upBtn, '上传中应显示「上传中…」');
  assert.equal(upBtn.props.disabled, true, '上传中应禁用选择按钮');

  const picked = render({ workflows: [WF_WITH_FILE], workflowId: 'wf-file', fileInputs: { doc: { uploadId: 'up-abc-12345678', name: '需求.docx', size: 2048 } } });
  assert.ok(picked.texts.some((t) => t.includes('需求.docx')), '已选择应显示文件名');
  assert.ok(btn(picked, '重新选择') && btn(picked, '清除'), '已选择应可重新选择/清除');
  assert.ok(picked.texts.some((t) => t.includes('${inputs.doc}')), '应提示节点里用 ${inputs.doc} 拿路径');

  // 放大编辑：覆盖层标题 + 两个编辑区（主区仍挂载）
  const full = render({ fullEditor: true });
  assert.ok(full.texts.includes('全屏编辑需求描述'), '放大编辑覆盖层应渲染');
  assert.equal(full.els.filter((e) => e.type === 'textarea').length, 2, '应为主编辑区 + 放大编辑两个 textarea');

  // 超阈值长文本：出现落盘提示
  const long = render({ description: '长'.repeat(9000) });
  assert.ok(long.texts.some((t) => /超过 8,000 字/.test(t)), '超阈值应提示完整需求将落盘');

  // 加载失败：错误提示在
  const bad = render({ workflows: [], workflowId: '', error: 'boom' });
  assert.ok(bad.texts.some((t) => t.includes('加载失败：boom')), '错误态应显示原因');

  // 全字段：任务输入参数 / 模型候选 / 工作目录候选都在
  const full2 = render({
    workflows: [{ id: 'wf1', name: 'WF', inputs: [{ name: 'p', label: '参数', required: true }] }],
    models: [{ provider: 'prov', model: 'mdl' }],
    cwdOptions: [{ path: 'D:/ws', title: 'ws' }],
    model: 'mdl', provider: 'prov',
  });
  const ph = full2.els.filter((e) => e.type === 'input').map((e) => String(e.props.placeholder || ''));
  assert.ok(ph.some((p) => p.includes('参数（必填）')), '工作流输入参数应渲染为输入框');
  // 已选中模型：首项显示「继承当前会话（prov/mdl）」，候选中不再重复列出同一个模型
  assert.ok(full2.texts.some((t) => t.includes('继承当前会话（prov/mdl）')), '模型下拉首项应显示当前模型');
  assert.ok(!full2.texts.includes('prov/mdl'), '已选中的模型不得在候选里重复出现');
  // 未选中模型：候选里应出现该模型
  const noModel = render({ workflows: [{ id: 'wf1', name: 'WF', inputs: [] }], models: [{ provider: 'prov', model: 'mdl' }], model: '', provider: '' });
  assert.ok(noModel.texts.includes('prov/mdl'), '未选中时模型候选应出现');
  assert.ok(full2.els.some((e) => e.type === 'option' && e.children.includes('ws')), '工作目录下拉应含候选');
});

test('NewTaskModal.render()：文件上传中 / 已提交中 / 无工作流时提交按钮必须禁用', () => {
  const NewTaskModal = loadNewTaskModal();
  for (const patch of [{ uploading: { doc: true } }, { busy: true }, { workflowId: '' }, { uploadingAtt: 2 }]) {
    const inst = new NewTaskModal({ onClose: () => {} });
    Object.assign(inst.state, { workflowId: 'wf1', ...patch });
    const { els } = flatten(inst.render());
    const submit = els.find((e) => e.type === 'button' && e.children.some((c) => c === '创建并启动'));
    assert.equal(submit.props.disabled, true, `状态 ${JSON.stringify(patch)} 下应禁用提交`);
  }
});

// ---------------------------------------------------------------------------
// 内置通用附件（无需声明）——用户诉求"文件没有看到在哪里选择"
// 要点：**零 inputs 声明**的工作流也必须看得到上传入口、能多选、能移除。
//
// 历史缺陷（2026-09-19 实机：选了文件"什么都没发生"，无报错、无请求、无 chip）：
// 旧写法在 onChange 里把 `e.target.files`（一个**活引用**）取出来后带进异步，并在同一个
// handler 里立刻 `e.target.value = ''` 清空 input —— 文件清空早于异步消费，`Array.from`
// 解出空数组、`files.length === 0` 直接 return，于是整条链路**静默死亡**（不进 catch，
// 所以没有 toast、没有网络请求、没有 console 报错，用户只能看到"没反应"）。
// 下面两条测试锁死修复后的行为：文件必须在 handler 内**同步**取出，失败必须可见。
// ---------------------------------------------------------------------------

/** 造一个 HTMLInputElement 的桩：files 是 FileList 桩，value 可赋值（模拟清空）。
 *  files **故意做成伪数组**：真 FileList 不是 Array（`Array.isArray(files) === false`），
 *  所以「handler 交出的是快照数组还是活引用」可以用 Array.isArray 区分——这是本文件
 *  唯一能证明旧写法已修好的判据（旧写法交出 e.target.files，真实输入下必非数组）。 */
function makeFileInputStub(names) {
  const files = {
    length: names.length,
    item: (i) => ({ name: names[i], size: 1024 }),
    0: { name: names[0], size: 1024 },
  };
  return { files, value: '', tagName: 'INPUT', type: 'file' };
}

test('NewTaskModal 附件 onChange：交给上传逻辑的必须是「已快照的数组」，不能是活引用', () => {
  const NewTaskModal = loadNewTaskModal({
    api: async () => ({ uploadId: 'up-sync-12345678', name: 'x', size: 1024 }),
  });
  const inst = new NewTaskModal({ onClose: () => {} });
  Object.assign(inst.state, { workflowId: 'wf1', workflows: [{ id: 'wf1', name: 'WF', inputs: [] }] });

  const { els } = flatten(inst.render());
  const picker = els.find((e) => e.type === 'input' && e.props.type === 'file' && e.props.multiple === true);
  assert.ok(picker && typeof picker.props.onChange === 'function', '附件选择器应绑定 onChange');

  // 拦截 handler 实际交出去的东西：旧写法交出**活 FileList**（同步清空 input.value 后即失效，
  // 异步消费时已成空 → 静默失败）；新写法交出 Array.from 得到的**快照数组**。这是两者可区分的判据。
  let handed = null;
  inst.selectAttachments = (arg) => { handed = arg; };
  const input = makeFileInputStub(['地址.txt']);
  picker.props.onChange({ currentTarget: input, target: input });

  assert.ok(Array.isArray(handed),
    `handler 必须交出数组快照（实际收到 ${Object.prototype.toString.call(handed)}）—— 活引用会在 input.value 清空后失效`);
  assert.deepEqual(handed.map((f) => f.name), ['地址.txt']);
});

test('NewTaskModal.selectAttachments()：拿到快照数组就能正常上传（回归 2026-09-19 静默失败）', async () => {
  const uploads = [];
  const NewTaskModal = loadNewTaskModal({
    api: async (path, opts) => {
      uploads.push([path, opts.body.name]);
      return { uploadId: 'up-sync-12345678', name: opts.body.name, size: 1024 };
    },
    FileReader: function FileReaderStub() {
      this.readAsArrayBuffer = () => { this.result = new Uint8Array([1]).buffer; if (this.onload) this.onload(); };
    },
  });
  const inst = new NewTaskModal({ onClose: () => {} });
  Object.assign(inst.state, { workflowId: 'wf1', workflows: [{ id: 'wf1', name: 'WF', inputs: [] }] });

  await inst.selectAttachments([{ name: '地址.txt', size: 1024 }]);

  assert.deepEqual(uploads, [['/uploads', '地址.txt']], '文件应在 handler 内同步取出后上传');
  assert.equal(inst.state.attachments.length, 1, '上传成功后附件应进入 state');
});

test('NewTaskModal 附件：上传失败必须在界面上留痕（不允许只靠一闪而过的 toast）', async () => {
  const NewTaskModal = loadNewTaskModal({
    api: async () => { throw new Error('服务端拒绝'); },
    FileReader: function FileReaderStub() {
      this.readAsArrayBuffer = () => { this.result = new Uint8Array([1]).buffer; if (this.onload) this.onload(); };
    },
  });
  const inst = new NewTaskModal({ onClose: () => {} });
  Object.assign(inst.state, { workflowId: 'wf1', workflows: [{ id: 'wf1', name: 'WF', inputs: [] }] });

  await inst.selectAttachments([{ name: '地址.txt', size: 1024 }]);

  assert.deepEqual(inst.state.attachments, [], '失败不得进入附件列表');
  const diag = (inst.state.attachDiag || []).join('\n');
  assert.ok(diag.length > 0, '必须留下可读诊断（诊断区渲染在弹窗里，用户可截图）');
  assert.ok(/服务端拒绝/.test(diag), `诊断应包含原因，实际：${diag}`);

  const { texts } = flatten(inst.render());
  assert.ok(texts.some((t) => String(t).includes('附件诊断')), '界面上应有「附件诊断」区域');
  assert.ok(texts.some((t) => String(t).includes('附件诊断') && String(t).includes('服务端拒绝')), '界面诊断应带出具体原因');
});

test('NewTaskModal.render()：零 inputs 声明的工作流也必须有附件上传入口（多选，且不依赖声明）', () => {
  const NewTaskModal = loadNewTaskModal();
  const inst = new NewTaskModal({ onClose: () => {} });
  // 用户实测的工作流状态：完全没有任何 inputs 声明
  Object.assign(inst.state, { workflowId: 'wf1', workflows: [{ id: 'wf1', name: 'WF', inputs: [] }] });
  const { els, texts } = flatten(inst.render());

  assert.ok(texts.some((t) => t === '附件（可选）'), '附件区必须渲染（不依赖任何声明）');
  const picker = els.find((e) => e.type === 'input' && e.props.type === 'file' && e.props.multiple === true);
  assert.ok(picker, '附件选择器应支持多选（用户一次会选好几个文件）');
  const btn = els.find((e) => e.type === 'button' && e.children.some((c) => c === '选择文件（可多选）'));
  assert.ok(btn, '应有「选择文件（可多选）」按钮');
  assert.notEqual(btn.props.disabled, true, '未上传时按钮应可用');
  assert.ok(texts.some((t) => t.includes('${inputs.附件}')), '应告诉用户节点里用 ${inputs.附件} 拿路径');
});

test('NewTaskModal.render()：已选附件显示文件名与大小、可逐个移除、达到上限时禁用选择', () => {
  const NewTaskModal = loadNewTaskModal();
  const render = (patch) => {
    const inst = new NewTaskModal({ onClose: () => {} });
    Object.assign(inst.state, { workflowId: 'wf1', workflows: [{ id: 'wf1', name: 'WF', inputs: [] }], ...patch });
    return flatten(inst.render());
  };

  const one = render({ attachments: [{ uploadId: 'up-a-12345678', name: '需求说明.docx', size: 2048 }] });
  assert.ok(one.texts.some((t) => t.includes('需求说明.docx')), '应显示已选附件名');
  assert.ok(one.texts.some((t) => t.includes('2048 B')), '应显示附件大小');
  assert.ok(one.texts.includes('已选 1 个'), '应显示已选数量');
  const x = one.els.find((e) => e.type === 'button' && e.children.some((c) => c === '✕'));
  assert.ok(x, '每个附件应有移除按钮');
  assert.equal(typeof x.props.onClick, 'function', '移除按钮必须绑定事件');

  const up = render({ attachments: [{ uploadId: 'up-a-12345678', name: 'a.md', size: 1 }], uploadingAtt: 2 });
  const upBtn = up.els.find((e) => e.type === 'button' && String(e.children[0] || '').startsWith('上传中…'));
  assert.ok(upBtn, '上传中应显示进度文案');
  assert.equal(upBtn.props.disabled, true, '上传中应禁用选择按钮');

  const full = render({ attachments: Array.from({ length: 20 }, (_, i) => ({ uploadId: `up-x${i}-12345678`, name: `f${i}.md`, size: 1 })) });
  const fullBtn = full.els.find((e) => e.type === 'button' && e.children.some((c) => c === '选择文件（可多选）'));
  assert.equal(fullBtn.props.disabled, true, '达到数量上限后不得再选（Host 也会拦，但别让用户白选）');
});

test('NewTaskModal.removeAttachment()：按下标移除，其余附件顺序与内容不变', () => {
  const NewTaskModal = loadNewTaskModal();
  const inst = new NewTaskModal({ onClose: () => {} });
  inst.state.attachments = [
    { uploadId: 'up-a-12345678', name: 'a.md', size: 1 },
    { uploadId: 'up-b-12345678', name: 'b.md', size: 2 },
    { uploadId: 'up-c-12345678', name: 'c.md', size: 3 },
  ];
  inst.removeAttachment(1);
  assert.deepEqual(inst.state.attachments.map((a) => a.name), ['a.md', 'c.md'], '移除后应只剩 a、c 且顺序不变');
});

test('NewTaskModal.selectAttachments()：上传成功后必须记下 uploadId/name/size（静默丢弃 = 用户选了文件却没带上）', async () => {
  const calls = [];
  const NewTaskModal = loadNewTaskModal({
    api: async (path, opts) => {
      calls.push([path, opts && opts.body && opts.body.name]);
      return { uploadId: 'up-srv-12345678', name: (opts.body.name || '').replace(/[\\/]/g, '_'), size: 3 };
    },
    FileReader: function FileReaderStub() {
      this.readAsArrayBuffer = () => {
        this.result = new Uint8Array([1, 2, 3]).buffer;
        if (this.onload) this.onload();
      };
    },
  });
  const inst = new NewTaskModal({ onClose: () => {} });

  await inst.selectAttachments([{ name: '需求说明.docx', size: 3 }]);

  assert.deepEqual(calls, [['/uploads', '需求说明.docx']], '应先上传到 Host 暂存');
  assert.equal(inst.state.attachments.length, 1, '上传成功后必须把附件记进 state（否则提交时什么都没有）');
  assert.deepEqual(
    { uploadId: inst.state.attachments[0].uploadId, name: inst.state.attachments[0].name, size: inst.state.attachments[0].size },
    { uploadId: 'up-srv-12345678', name: '需求说明.docx', size: 3 },
    '应使用 Host 返回的 uploadId/name/size（不是本地文件对象）',
  );
  assert.equal(inst.state.uploadingAtt, 0, '上传结束后计数必须归零（否则提交按钮永久禁用）');
});

test('NewTaskModal.selectAttachments()：上传失败只提示、不留下半条记录（且计数归零）', async () => {
  const NewTaskModal = loadNewTaskModal({
    api: async () => { throw new Error('boom'); },
    FileReader: function FileReaderStub() {
      this.readAsArrayBuffer = () => { this.result = new Uint8Array([1]).buffer; if (this.onload) this.onload(); };
    },
  });
  const inst = new NewTaskModal({ onClose: () => {} });
  await inst.selectAttachments([{ name: 'a.md', size: 1 }]);
  assert.deepEqual(inst.state.attachments, [], '上传失败的附件不得进入列表');
  assert.equal(inst.state.uploadingAtt, 0, '失败后计数也要归零');
});

// ---------------------------------------------------------------------------
// 任务详情：inputs.附件 的展示（用户要看节点到底拿到了哪些文件）
// ---------------------------------------------------------------------------

test('SidebarTaskDetail.renderTaskInputValues()：inputs.附件 拆成逐行文件路径（没有声明也要显示）', () => {
  const methodSrc = extractMethod(src, 'renderTaskInputValues').replace('renderTaskInputValues() {', 'function renderTaskInputValues() {');
  const deps = { react: makeReactStub(), ATTACHMENTS_INPUT_NAME: '附件' };
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `${methodSrc}\nreturn renderTaskInputValues;`)(...names.map((n) => deps[n]));
  const call = (inputs, snapshotInputs) => fn.call({ props: { task: { id: 't', inputs, workflowSnapshot: { inputs: snapshotInputs || [] } } } });

  // 零声明 + 两个附件：必须逐行显示（只按声明判定时这里会整块不渲染）
  const two = call({ 附件: 'D:\\ws\\.knj-inputs\\t\\a.docx\nD:\\ws\\.knj-inputs\\t\\b.md' }, []);
  const texts = flatten(two).texts;
  assert.ok(texts.includes('📎 附件 1') && texts.includes('📎 附件 2'), '每个附件应单独一行');
  assert.ok(texts.includes('D:\\ws\\.knj-inputs\\t\\a.docx'), '应显示附件绝对路径（节点实际拿到的东西）');
  assert.ok(texts.some((t) => t.includes('自行解析文档')), '应提示这是落盘后的路径');

  // 单附件一行
  const one = flatten(call({ 附件: 'D:\\ws\\a.md' }, [])).texts;
  assert.ok(one.includes('📎 附件 1') && !one.includes('📎 附件 2'), '单个附件只应有一行');

  // 声明式文本入参照旧
  const txt = flatten(call({ p: 'v' }, [{ name: 'p' }])).texts;
  assert.ok(txt.includes('p') && txt.includes('v'), '普通文本入参照旧渲染');

  // 无任何输入 → 整块不渲染
  assert.equal(call({}, []), null, '无输入时不渲染该区');
});

// ---------------------------------------------------------------------------
// 任务详情「需求描述」区（SidebarTaskDetail.renderRequirement）：同为本次新增的渲染代码，
// 用户建完任务后必然点到，所以单独抽出来直接执行（而不是又一条源码正则）。
// ---------------------------------------------------------------------------

/** 按花括号配平从源码里抽出某个类方法（模板串里的 ${...} 花括号是配平的，不影响计数）。 */
function extractMethod(source, name, params = '') {
  const head = `\n\t\t\t${name}(${params}) {`;
  const start = source.indexOf(head);
  assert.ok(start > 0, `应能定位方法 ${name}()`);
  let depth = 0;
  for (let i = start + head.length - 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start + 1, i + 1);
    }
  }
  throw new Error(`方法 ${name}() 花括号未配平`);
}

/** 按花括号配平抽出工厂作用域里的普通函数（2 tab 缩进）。 */
function extractFactoryFn(source, name) {
  const needle = `\n\t\tfunction ${name}(`;
  const start = source.indexOf(needle);
  assert.ok(start > 0, `应能定位工厂函数 ${name}()`);
  let depth = 0;
  for (let i = start + needle.length; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start + 1, i + 1);
    }
  }
  throw new Error(`${name}() 花括号未配平`);
}

test('SidebarTaskDetail.renderHumanCard()：缺 workflowSnapshot 的历史任务必须能渲染（曾因 humanRoutes(undefined) 白屏）', () => {
  const humanRoutesSrc = extractFactoryFn(src, 'humanRoutes');
  const cardSrc = extractMethod(src, 'renderHumanCard', 'task').replace('renderHumanCard(task) {', 'function renderHumanCard(task) {');
  // eslint-disable-next-line no-new-func
  const fn = new Function('react', `${humanRoutesSrc}\n${cardSrc}\nreturn renderHumanCard;`)(makeReactStub());

  const host = () => ({
    props: { task: null },
    state: { results: null, preview: null, rejectFeedback: '', fileView: null },
    looksLikePathStr: () => false,
    tryOpenSidebar: () => false,
    openPreview() {}, renderPreviewPanel: () => null, fileIcon: () => '📄', decide() {},
  });

  // 历史缺陷形态：调度器创建的历史任务没有 workflowSnapshot → humanNode 为 undefined
  const legacy = host();
  let tree;
  assert.doesNotThrow(() => {
    tree = fn.call(legacy, { id: 't1', status: 'waiting-human', humanState: { humanId: 'h1' } });
  }, 'humanRoutes(undefined) 抛错会让整棵 React 树卸载（人工审批卡白屏，2026.9.110 修复过）');
  assert.ok(flatten(tree).texts.some((t) => t.includes('未配置去向')), '无快照/无去向时应渲染兜底文案');

  // 正常形态：有快照 + 人工节点配了去向 → 渲染去向按钮（注意：方法读的是入参 task，不是 this.props.task）
  const normalTask = {
    id: 't2', status: 'waiting-human', humanState: { humanId: 'h1' },
    workflowSnapshot: { nodes: [{ id: 'h1', type: 'human', title: '人工评审', routes: [{ label: '通过', to: 'end', tone: 'success' }, { label: '驳回', to: 'n1', tone: 'danger' }] }] },
  };
  const normalTree = fn.call(host(), normalTask);
  const texts = flatten(normalTree).texts;
  assert.ok(texts.includes('通过') && texts.includes('驳回'), '配了去向时应渲染去向按钮');
});

test('SidebarTaskDetail.renderRequirement()：折叠/展开/无描述三态都必须能渲染', () => {
  // 抽出的是「方法简写」形态，编译前转成函数声明
  const methodSrc = extractMethod(src, 'renderRequirement').replace('renderRequirement() {', 'function renderRequirement() {');
  const deps = {
    react: makeReactStub(),
    fmtChars: (n) => Number(n || 0).toLocaleString('en-US'),
    copyRequirement: () => {},
  };
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `${methodSrc}\nreturn renderRequirement;`)(...names.map((n) => deps[n]));

  const long = ['第一行', '第二行', '第三行', '第四行', '第五行'].join('\n');
  const base = { props: { task: { id: 'task-1', title: 'T', description: long } }, state: { reqOpen: false }, setState() {}, copyRequirement() {} };

  const collapsed = fn.call(base);
  const c = flatten(collapsed);
  assert.ok(c.texts.some((t) => t.includes('需求描述（')), '应显示需求描述标题与字数');
  assert.ok(c.texts.includes('展开全文'), '长需求默认折叠');
  assert.ok(!c.texts.some((t) => t.includes('第四行')), '折叠态只显示前 3 行');

  const expanded = fn.call({ ...base, state: { reqOpen: true } });
  const e = flatten(expanded);
  assert.ok(e.texts.some((t) => t.includes('第四行')), '展开态显示全文');
  assert.ok(e.texts.includes('收起'), '展开后按钮文案应变为收起');

  assert.equal(fn.call({ ...base, props: { task: { id: 't', title: 'T' } } }), null, '无描述时不渲染该区');

  const withFile = fn.call({ ...base, props: { task: { id: 't', title: 'T', description: long, descriptionFile: 'D:/data/tasks/t/requirement.md' } } });
  assert.ok(flatten(withFile).texts.some((t) => t.includes('requirement.md')), '大文本应给出完整需求文件入口');
});
