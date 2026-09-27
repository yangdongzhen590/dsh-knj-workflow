/**
 * 工作流「任务输入参数」声明校验（node:test，零依赖）
 *
 * 背景（OpenSpec: add-knj-task-file-inputs）：`workflow.inputs` 此前**完全没有校验**，
 * 也没有任何界面能声明它（新建工作流是 `inputs: []`，只能手改 workflows.json）。
 * 本次要加 `type: 'text' | 'file'`，因此先补上声明校验：
 *  - name 必须存在、唯一、且能安全用在路径与 `${inputs.<name>}` 引用里（**不允许点号**——
 *    引用解析按 '.' 逐段取值，`a.b` 会被解析成 `inputs.a` 再取 `.b`，必然取不到）；
 *  - type 只有 text / file 两种，缺省即 text（老工作流不受影响）；
 *  - required 归一为布尔，label 归一为字符串。
 *
 * 运行：node --test lib/workflow-inputs.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflowInputs, validateWorkflow, prepareWorkflowForSave } from './graph.js';

const WF = (inputs) => ({
  id: 'wf-x', name: 'X', schemaVersion: 2, inputs,
  nodes: [{ id: 'start', type: 'start' }, { id: 'n1', type: 'task', title: 'T', body: { prompt: 'p' } }, { id: 'end', type: 'end' }],
  edges: [{ from: 'start', to: 'n1' }, { from: 'n1', to: 'end' }],
});

test('inputs：缺省/空数组 → 合法，归一为空数组', () => {
  for (const raw of [undefined, null, []]) {
    const r = validateWorkflowInputs(raw);
    assert.equal(r.ok, true, `${JSON.stringify(raw)} 应合法`);
    assert.deepEqual(r.inputs, []);
  }
});

test('inputs：缺省 type 即 text（老工作流不受影响），required 归一为布尔', () => {
  const r = validateWorkflowInputs([{ name: 'doc' }, { name: 'n', label: '数量', required: 1, type: 'text' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.inputs[0], { name: 'doc', label: '', required: false, type: 'text' });
  assert.equal(r.inputs[1].label, '数量');
  assert.equal(r.inputs[1].required, true, 'truthy 的 required 应归一为 true');
});

test('inputs：合法 file 入参', () => {
  const r = validateWorkflowInputs([{ name: '需求文档', label: '需求 docx', required: true, type: 'file' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.inputs[0], { name: '需求文档', label: '需求 docx', required: true, type: 'file' });
});

test('inputs：name 含点号必须拒（${inputs.a.b} 无法解析）', () => {
  const r = validateWorkflowInputs([{ name: 'a.b' }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(';'), /a\.b/);
});

test('inputs：name 含空白/路径分隔符/Windows 非法字符必须拒', () => {
  for (const bad of ['', '   ', 'a b', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', '..', '.']) {
    const r = validateWorkflowInputs([{ name: bad }]);
    assert.equal(r.ok, false, `name=${JSON.stringify(bad)} 应被拒`);
  }
});

test('inputs：name 允许中文/数字/下划线/连字符（便于 ${inputs.需求文档} 引用）', () => {
  for (const good of ['需求文档', 'doc', 'doc-1', 'doc_2', 'D1']) {
    assert.equal(validateWorkflowInputs([{ name: good }]).ok, true, `name=${good} 应合法`);
  }
});

test('inputs：name 重复必须拒', () => {
  const r = validateWorkflowInputs([{ name: 'doc' }, { name: 'doc', type: 'file' }]);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(';'), /重复|duplicate/);
});

test('inputs：type 只接受 text / file', () => {
  assert.equal(validateWorkflowInputs([{ name: 'x', type: 'pdf' }]).ok, false);
  assert.equal(validateWorkflowInputs([{ name: 'x', type: 'FILE' }]).ok, false, '大小写不敏感不算合法，必须显式小写');
  assert.equal(validateWorkflowInputs([{ name: 'x', type: 'text' }]).ok, true);
  assert.equal(validateWorkflowInputs([{ name: 'x', type: 'file' }]).ok, true);
});

test('inputs：非对象条目必须拒（不能静默丢弃）', () => {
  for (const bad of ['doc', 42, null, [['a']]]) {
    assert.equal(validateWorkflowInputs([bad]).ok, false, `条目 ${JSON.stringify(bad)} 应被拒`);
  }
  assert.equal(validateWorkflowInputs({ doc: 'file' }).ok, false, 'inputs 必须是数组，不接受对象');
});

test('validateWorkflow：把 inputs 校验结果并入整体校验（错误信息含参数名）', () => {
  const ok = validateWorkflow(WF([{ name: 'doc', type: 'file' }]));
  assert.equal(ok.ok, true);
  const bad = validateWorkflow(WF([{ name: 'a.b', type: 'file' }]));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('a.b')), '错误信息应指出是哪个参数');
});

test('prepareWorkflowForSave：归一后的 inputs 落库（type 显式写出）', () => {
  const r = prepareWorkflowForSave(WF([{ name: 'doc' }]), null);
  assert.equal(r.ok, true);
  assert.deepEqual(r.workflow.inputs, [{ name: 'doc', label: '', required: false, type: 'text' }]);
});

test('prepareWorkflowForSave：非法 inputs 拒绝保存且不改动传入对象', () => {
  const wf = WF([{ name: 'x', type: 'pdf' }]);
  const r = prepareWorkflowForSave(wf, null);
  assert.equal(r.ok, false);
  assert.equal(wf.revision, undefined, '校验失败不得写入 revision 等副作用');
});
