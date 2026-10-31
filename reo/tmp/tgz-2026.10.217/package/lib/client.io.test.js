/**
 * dsh-knj-workflow 工作流模板导入/导出（client 端纯逻辑）单元测试（node:test，零依赖）
 * 覆盖：
 *  - parseWorkflowFile：JSON 解析、结构校验、旧版 stage 格式提示、start/end 补齐、坐标补齐、同 ID 冲突标记
 *  - exportWorkflowFile：模板字段序列化、下载文件名
 * 运行：node --test lib/client.io.test.js
 *
 * 说明：client.js 是浏览器 bundle（window.__ModuleLoader__.load 包装），
 * 这里用 stub 的 window/document/URL/Blob/react 加载同一份源码，取 factory 返回的
 * exports.__test 里的纯函数做断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// ---- 浏览器环境 stub（仅加载所需，不执行任何真实 DOM/网络） ----
const createdEls = [];
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      const require = (id) => {
        if (id === 'react') return { Component: class {} };
        if (id === 'react-dom/client') return {};
        throw new Error('unexpected require: ' + id);
      };
      loadedExports = spec.factory(require);
    },
  },
};
globalThis.document = {
  createElement: (tag) => {
    const el = { tag, download: '', clicked: false, click() { this.clicked = true; }, remove() {} };
    createdEls.push(el);
    return el;
  },
  body: { appendChild() {}, removeChild() {} },
};
const createdBlobs = [];
globalThis.Blob = class {
  constructor(parts, opts) { this.parts = parts; this.opts = opts; createdBlobs.push(this); }
};
globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL() {} };

/** 最近一次「下载链接」元素（downloadJson 创建的第一个 <a>） */
function lastAnchor() {
  return [...createdEls].reverse().find((e) => e.tag === 'a');
}

let loadedExports = null;
vm.runInThisContext(readFileSync(join(import.meta.dirname, 'client.js'), 'utf8'), { filename: 'client.js' });

const { parseWorkflowFile, exportWorkflowFile } = loadedExports.__test;

/** 构造一个合法导出模板（模拟 exportWorkflowFile 的产物） */
function sampleWf(over = {}) {
  return {
    id: 'wf-dev-pipeline',
    name: '开发任务流水线',
    description: '需求 → 编码 → 评审',
    schemaVersion: 2,
    inputs: [{ name: 'storyCode', label: '用户故事编码', required: false }],
    nodes: [
      { id: 'start', type: 'start', x: 100, y: 100 },
      { id: 'analyze', type: 'task', title: '分析', x: 300, y: 100, inputs: [], body: { prompt: '分析需求', mode: 'single', output: {} } },
      { id: 'end', type: 'end', x: 500, y: 100 },
    ],
    edges: [
      { from: 'start', to: 'analyze' },
      { from: 'analyze', to: 'end' },
    ],
    ...over,
  };
}

test('parseWorkflowFile：接受裸工作流对象，字段原样保留', () => {
  const r = parseWorkflowFile(JSON.stringify(sampleWf()), ['wf-other']);
  assert.equal(r.ok, true);
  assert.equal(r.wf.id, 'wf-dev-pipeline');
  assert.equal(r.wf.name, '开发任务流水线');
  assert.equal(r.wf.schemaVersion, 2);
  assert.equal(r.wf.nodes.length, 3);
  assert.equal(r.wf.edges.length, 2);
  assert.equal(r.conflict, false);
});

test('parseWorkflowFile：兼容 { workflow: {...} } 包装', () => {
  const r = parseWorkflowFile(JSON.stringify({ workflow: sampleWf() }), []);
  assert.equal(r.ok, true);
  assert.equal(r.wf.id, 'wf-dev-pipeline');
});

test('parseWorkflowFile：非法 JSON 报错且 ok=false', () => {
  const r = parseWorkflowFile('{not json', []);
  assert.equal(r.ok, false);
  assert.match(r.error, /不是合法 JSON/);
});

test('parseWorkflowFile：非工作流对象（缺 nodes/edges）报错', () => {
  const r = parseWorkflowFile(JSON.stringify({ id: 'x', name: 'y' }), []);
  assert.equal(r.ok, false);
  assert.match(r.error, /nodes \/ edges/);
});

test('parseWorkflowFile：旧版 stage 数组格式给出明确提示', () => {
  const r = parseWorkflowFile(JSON.stringify({ id: 'x', name: 'y', stages: [{ id: 's1', title: '阶段1' }] }), []);
  assert.equal(r.ok, false);
  assert.match(r.error, /旧版 stage 数组格式/);
});

test('parseWorkflowFile：缺 start/end 时自动补齐', () => {
  const wf = sampleWf();
  wf.nodes = wf.nodes.filter((n) => n.type !== 'start' && n.type !== 'end');
  const r = parseWorkflowFile(JSON.stringify(wf), []);
  assert.equal(r.ok, true);
  const types = r.wf.nodes.map((n) => n.type);
  assert.ok(types.includes('start'), '应补 start');
  assert.ok(types.includes('end'), '应补 end');
});

test('parseWorkflowFile：缺坐标节点补齐数字坐标（防 SVG NaN）', () => {
  const wf = sampleWf();
  delete wf.nodes[1].x;
  delete wf.nodes[1].y;
  const r = parseWorkflowFile(JSON.stringify(wf), []);
  assert.equal(r.ok, true);
  assert.equal(typeof r.wf.nodes[1].x, 'number');
  assert.equal(typeof r.wf.nodes[1].y, 'number');
});

test('parseWorkflowFile：本地已存在同 ID 时标记 conflict', () => {
  const r = parseWorkflowFile(JSON.stringify(sampleWf()), ['wf-dev-pipeline', 'wf-other']);
  assert.equal(r.ok, true);
  assert.equal(r.conflict, true);
});

test('exportWorkflowFile：下载 <id>.workflow.json，字段干净（无多余字段）', () => {
  const wf = sampleWf();
  const out = exportWorkflowFile(wf);
  assert.equal(out.id, 'wf-dev-pipeline');
  const a = lastAnchor();
  assert.equal(a.download, 'wf-dev-pipeline.workflow.json');
  assert.equal(a.clicked, true);
  assert.deepEqual(Object.keys(out).sort(), ['description', 'edges', 'id', 'inputs', 'name', 'nodes', 'schemaVersion']);
  const body = JSON.parse(createdBlobs[createdBlobs.length - 1].parts[0]);
  assert.equal(body.name, '开发任务流水线');
  assert.equal(body.schemaVersion, 2);
});

test('exportWorkflowFile：id 为空时回退文件名 workflow.workflow.json', () => {
  exportWorkflowFile({ id: '', name: '未命名' });
  assert.equal(lastAnchor().download, 'workflow.workflow.json');
});
