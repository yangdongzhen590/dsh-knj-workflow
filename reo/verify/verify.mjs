// 复核报告中的问题是否仍然存在（只读）
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const out = [];
const p = (s = '') => out.push(s);
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const C = (f) => readFileSync(join(ROOT, f), 'utf8');

p('### A. 代码是否变过（工作区 vs 已安装副本）');
const inst = join(homedir(), '.dsh/profiles/web/node_modules/dsh-knj-workflow');
let same = 0, diff = 0, missing = 0;
for (const f of readdirSync(join(ROOT, 'lib'))) {
  const a = join(ROOT, 'lib', f), b = join(inst, 'lib', f);
  if (!existsSync(b)) { missing++; continue; }
  if (sha(a) === sha(b)) same++; else diff++;
}
p(`lib/ 文件：worktree==installed ${same}，不同 ${diff}，安装副本缺 ${missing}`);
p(`installed version: ${JSON.parse(readFileSync(join(inst, 'package.json'), 'utf8')).version}`);

p('\n### B. 代码侧事实（逐条复核）');
const idx = C('lib/index.js');
const routes = [...idx.matchAll(/^\s{4}\['(GET|POST|PUT|DELETE)', '([^']+)'/gm)].map((m) => m[1] + ' ' + m[2]);
p(`B1 路由条数: ${routes.length}（报告写 24）`);
const readme = C('README.md');
const readmeRows = readme.split(/\r?\n/).filter((l) => /^\|\s*(GET|POST|PUT|DELETE)/.test(l));
const readmeMethods = readmeRows.reduce((n, l) => n + l.split('|')[1].split('/').length, 0);
p(`B2 README API 表：行 ${readmeRows.length} 行 / 展开 ${readmeMethods} 个方法`);
const missingFromReadme = routes.filter((r) => {
  const [meth, path] = r.split(' ');
  return !new RegExp(`\\|\\s*[^|]*${meth}[^|]*\\|[^\\n]*${path.replace(/:[a-zA-Z]+/g, '')}`).test(readme)
    && !readme.includes(path.split('/:')[0]);
});
p(`B3 代码有、README 表未覆盖的路由: ${missingFromReadme.length} 条 -> ${missingFromReadme.join(', ')}`);
p(`B4 README 引用的文档存在？ DESIGN.md=${existsSync('DESIGN.md')} design/=${existsSync('design')}`);
p(`B5 编排器消费 resumeFrom/rerunStage? ${/resumeFrom|rerunStage/.test(C('lib/orchestrator.js'))}`);
p(`B6 client 写死前缀: ${/const PREFIX = '\/devtask'/.test(C('lib/client.js'))}`);
p(`B7 client inject 数组: ${(C('lib/client.js').match(/const inject = \[([^\]]*)\]/) || [])[1]}`);
p(`B8 openOverlay 调用点（除定义）: ${(C('lib/client.js').match(/openOverlay\(/g) || []).length - 1}`);
const reg = (idx.match(/commands\.register\(\{[\s\S]{0,400}?\}\)/) || [''])[0];
p(`B9 命令注册传参含 execute=${/execute\s*\(/.test(reg)} / handler=${/handler\s*:/.test(reg)}`);
const hostCommands = join(ROOT, '..', '..', '..'); // placeholder
p(`B10 宿主要求 handler: 见 C 段`);
p(`B11 graph.js 是否含客户端几何: routeEdge=${/export function routeEdge\b/.test(C('lib/graph.js'))} roundedOrtho=${/roundedOrthoPath/.test(C('lib/graph.js'))}`);
p(`B12 客户端镜像注释: ${(C('lib/client.js').match(/镜像 graph\.js|两处需同步/g) || []).length} 处`);
p(`B13 日志路径硬编码 ~/.dsh（忽略 dataRoot/DSH_HOME）: ${/join\(homedir\(\), '\.dsh', 'dev-orchestrator'\)/.test(idx)}`);
p(`B14 readJson 异常静默 fallback: ${/async function readJson[\s\S]{0,220}catch[\s\S]{0,80}return fallback/.test(idx)}`);
p(`B15 files 白名单: ${JSON.parse(C('package.json')).files.join(',')}`);

p('\n### B2-实测：validateWorkflow 是否仍放过 task 零出边');
const g = await import(pathToFileURL(join(ROOT, 'lib/graph.js')).href);
const badWf = {
  id: 'x', name: 'x', inputs: [], nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'task', title: 't1', body: { prompt: 'p' } }, { id: 'end', type: 'end' }],
  edges: [{ from: 'start', to: 't1' }],
};
const v = g.validateWorkflow(badWf);
p(`validateWorkflow(task 零出边) => ok=${v.ok} errors=${JSON.stringify(v.errors)}`);

p('\n### C. 宿主命令契约（dsh-commands）');
const dshRoot = join(process.env.APPDATA || '', 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-commands/lib/index.js');
if (existsSync(dshRoot)) {
  const hc = readFileSync(dshRoot, 'utf8');
  p(`存在 'handler must be a function': ${hc.includes('handler must be a function')}`);
  p(`normalizeDefinition 要求 handler: ${/handler/.test(hc) && hc.includes('handler must be a function')}`);
  p(`结果形状 kind: ${hc.includes("kind:") || hc.includes('"kind"')}`);
} else p('dsh-commands 未找到');

p('\n### D. 真实使用数据（现在重算）');
const dataRoot = join(homedir(), '.dsh/dev-orchestrator');
const tasksDir = join(dataRoot, 'tasks');
const dirs = existsSync(tasksDir) ? readdirSync(tasksDir) : [];
const tasks = [];
for (const d of dirs) {
  const f = join(tasksDir, d, 'task.json');
  if (existsSync(f)) {
    try { tasks.push(JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))); } catch { tasks.push({ id: d, __bad: true }); }
  }
}
const by = {};
for (const t of tasks) by[t.status] = (by[t.status] || 0) + 1;
p(`D1 任务目录 ${dirs.length}，可解析 task.json ${tasks.length}，状态分布 ${JSON.stringify(by)}`);
p(`D2 需求长度 max=${Math.max(...tasks.map((t) => (t.description || '').length))}，带 requirement.md 任务数 ${dirs.filter((d) => existsSync(join(tasksDir, d, 'requirement.md'))).length}`);
p(`D3 带 archivedAt 的任务 ${tasks.filter((t) => t.archivedAt).length}`);
p(`D4 有 inputs 的任务 ${tasks.filter((t) => t.inputs && Object.keys(t.inputs).length).length}`);
const wfs = JSON.parse(readFileSync(join(dataRoot, 'workflows.json'), 'utf8')).workflows;
const types = {};
let skillUsed = 0, declaredInputs = 0, parallel = 0;
for (const w of wfs) {
  for (const n of w.nodes || []) {
    types[n.type] = (types[n.type] || 0) + 1;
    if (n.body && n.body.skill) skillUsed++;
    if (n.body && n.body.mode === 'parallel') parallel++;
  }
  if ((w.inputs || []).length) declaredInputs++;
}
p(`D5 工作流 ${wfs.length}，节点类型 ${JSON.stringify(types)}`);
p(`D6 skill 使用 ${skillUsed}，parallel 节点 ${parallel}，声明输入的工作流 ${declaredInputs}/${wfs.length}`);
const stageFiles = dirs.flatMap((d) => { const s = join(tasksDir, d, 'stages'); return existsSync(s) ? readdirSync(s).map((f) => join(s, f)) : []; });
p(`D7 阶段断点文件 ${stageFiles.length}`);
const sessions = tasks.reduce((n, t) => n + (t.stageStates || []).reduce((m, s) => m + ((s.sessionIds || []).length), 0), 0);
const decisions = tasks.reduce((n, t) => n + ((t.decisions || []).length), 0);
p(`D8 subagent 会话引用 ${sessions}，人工决策 ${decisions}`);
p(`D9 带 BOM 的 task.json: ${dirs.filter((d) => { const f = join(tasksDir, d, 'task.json'); return existsSync(f) && readFileSync(f)[0] === 0xEF; }).length}`);

p('\n### E. 诊断日志（现在）');
const logF = join(dataRoot, 'knj-host-debug.log');
if (existsSync(logF)) {
  const st = statSync(logF);
  const lines = readFileSync(logF, 'utf8').split('\n').filter(Boolean);
  const ids = new Set();
  let degrade = 0, reqIds = new Set(), bad = 0;
  for (const l of lines) {
    const m = l.match(/"taskId":"([^"]+)"/);
    if (m) ids.add(m[1]);
    if (l.includes('降级为阶段级过程')) degrade++;
    const r = l.match(/"requestId":"([^"]+)"/);
    if (r) reqIds.add(r[1]);
  }
  const realIds = new Set(tasks.map((t) => t.id));
  let realLines = 0;
  for (const l of lines) { const m = l.match(/"taskId":"([^"]+)"/); if (m && realIds.has(m[1])) realLines++; }
  p(`E1 日志 ${st.size} B / ${lines.length} 行；distinct taskId ${ids.size}；命中真实任务的行 ${realLines} (${(realLines / lines.length * 100).toFixed(1)}%)`);
  p(`E2 assist requestId ${reqIds.size} 个；降级行 ${degrade}`);
  p(`E3 首行: ${lines[0].slice(0, 90)}`);
  p(`E4 末行: ${lines[lines.length - 1].slice(0, 90)}`);
}

p('\n### F. 打包与 git');
try {
  const tgz = 'dsh-knj-workflow-2026.10.218.tgz';
  const list = execSync(`tar -tzf "${tgz}"`, { encoding: 'utf8' }).split('\n').filter(Boolean);
  p(`F1 tgz 条目 ${list.length}，其中 *.test.js ${list.filter((x) => x.endsWith('.test.js')).length}，repro ${list.filter((x) => x.includes('repro-')).length}`);
} catch (e) { p('F1 tgz 读取失败 ' + e.message); }
try {
  p(`F2 git HEAD: ${execSync('git log -1 --format=%h %ad %s --date=short', { encoding: 'utf8' }).trim()}`);
  p(`F3 tags: ${execSync('git tag', { encoding: 'utf8' }).trim() || '(none)'}`);
  p(`F4 未提交改动: ${execSync('git status --porcelain', { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length} 项`);
} catch (e) { p('F git 失败 ' + e.message); }

p('\n### G. better-sidebar 现状');
p(`G1 已安装: ${existsSync(join(homedir(), '.dsh/profiles/web/node_modules/dsh-better-sidebar'))}`);
try {
  const state = JSON.parse(readFileSync(join(homedir(), '.dsh/profiles/web/.dsh-market/state.json'), 'utf8'));
  p(`G2 market disabled 含 better-sidebar: ${JSON.stringify(state.disabled || []).includes('better-sidebar')}`);
} catch { p('G2 market state 读取失败'); }

console.log(out.join('\n'));
