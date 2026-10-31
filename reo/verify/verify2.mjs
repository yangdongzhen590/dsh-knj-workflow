import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = process.cwd();
const C = (f) => readFileSync(join(ROOT, f), 'utf8');
const p = (s) => console.log(s);

// 1) 命令注册块原文
const idx = C('lib/index.js');
const i = idx.indexOf('commands.register');
p('=== 1) commands.register 原文（index.js:' + (idx.slice(0, i).split('\n').length) + '）===');
p(idx.slice(i - 120, i + 420));

// 2) 宿主 commands 契约
const hcPath = join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-commands/lib/index.js');
const hc = readFileSync(hcPath, 'utf8');
const j = hc.indexOf('handler must be a function');
p('\n=== 2) 宿主 dsh-commands 的 handler 校验（上下文）===');
p(hc.slice(Math.max(0, j - 700), j + 260));

// 3) README 覆盖对账（精确）
const readme = C('README.md');
const routes = [...idx.matchAll(/^\s{4}\['(GET|POST|PUT|DELETE)', '([^']+)'/gm)].map((m) => ({ m: m[1], path: m[2] }));
const readmeBlock = readme.slice(readme.indexOf('## HTTP API'), readme.indexOf('## AI 助手'));
const documented = routes.filter((r) => readmeBlock.includes(r.path));
p('\n=== 3) README HTTP API 表覆盖 ===');
p(`路由 ${routes.length} 条；README 表直接出现的路径 ${documented.length} 条`);
p('未出现: ' + routes.filter((r) => !readmeBlock.includes(r.path)).map((r) => r.m + ' ' + r.path).join(' | '));

// 4) 数据侧变化细节
const dataRoot = join(homedir(), '.dsh/dev-orchestrator');
const tasksDir = join(dataRoot, 'tasks');
const tasks = [];
for (const d of readdirSync(tasksDir)) {
  const f = join(tasksDir, d, 'task.json');
  if (!existsSync(f)) continue;
  try { tasks.push(JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))); } catch {}
}
p('\n=== 4) 数据侧：变化点 ===');
const arch = tasks.filter((t) => t.archivedAt);
p(`归档任务: ${arch.map((t) => `${t.id}(${t.title}, archivedAt=${t.archivedAt})`).join('; ') || '无'}`);
const withInputs = tasks.filter((t) => t.inputs && Object.keys(t.inputs).length);
p(`有 inputs 的任务: ${withInputs.map((t) => `${t.id} -> ${JSON.stringify(Object.keys(t.inputs))}`).join('; ')}`);
const longest = tasks.slice().sort((a, b) => (b.description || '').length - (a.description || '').length)[0];
p(`最长需求: ${(longest.description || '').length} 字 | title=${longest.title} | status=${longest.status}`);
p(`需求长度分布: ${JSON.stringify(tasks.map((t) => (t.description || '').length).sort((a, b) => b - a).slice(0, 8))}`);
p(`createdAt 最新 3 个任务: ${tasks.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 3).map((t) => `${t.id} ${t.createdAt} ${t.status}`).join(' | ')}`);

// 5) git
p('\n=== 5) git ===');
