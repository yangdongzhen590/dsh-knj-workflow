import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/MrYang/.dsh/dev-orchestrator/tasks';
const dirs = fs.readdirSync(ROOT).filter(d => fs.statSync(path.join(ROOT, d)).isDirectory());
const readJson = p => { let s = fs.readFileSync(p, 'utf8'); if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); return JSON.parse(s); };

const noTaskJson = [];
const statusCount = {}, stageStatusCount = {}, wfUse = {}, stageIdNames = {};
const errors = [];
const dates = [];
let decisionsNonEmpty = [], humanStates = [], inputsTasks = [];
const titles = [];
const fieldsByTaskCount = {};

for (const d of dirs) {
  const tdir = path.join(ROOT, d);
  const tj = path.join(tdir, 'task.json');
  if (!fs.existsSync(tj)) { noTaskJson.push({ id: d, files: fs.readdirSync(tdir) }); continue; }
  let t;
  try { t = readJson(tj); } catch (e) { errors.push({ id: d, parseError: e.message }); continue; }
  const st = t.status ?? '(none)'; statusCount[st] = (statusCount[st] ?? 0) + 1;
  wfUse[t.workflowId] = (wfUse[t.workflowId] ?? 0) + 1;
  titles.push({ id: d, title: t.title, desc: t.description, storyCode: t.storyCode, status: st, cwd: t.cwd });
  if (t.error) errors.push({ id: d, status: st, error: String(t.error).slice(0, 300) });
  for (const s of (t.stageStates ?? [])) {
    const k = s.status ?? '?'; stageStatusCount[k] = (stageStatusCount[k] ?? 0) + 1;
    stageIdNames[s.id] = (stageIdNames[s.id] ?? 0) + 1;
  }
  if (Array.isArray(t.decisions) && t.decisions.length) decisionsNonEmpty.push({ id: d, n: t.decisions.length, sample: JSON.stringify(t.decisions[0]).slice(0, 300) });
  if (t.humanState) humanStates.push({ id: d, humanId: t.humanState.humanId, resultKeys: Object.keys(t.humanState.results ?? {}), sample: JSON.stringify(t.humanState).slice(0, 260) });
  if (t.inputs && Object.keys(t.inputs).length) inputsTasks.push({ id: d, keys: Object.keys(t.inputs), sample: JSON.stringify(t.inputs).slice(0, 300) });
  const nk = Object.keys(t).length; fieldsByTaskCount[nk] = (fieldsByTaskCount[nk] ?? 0) + 1;
  if (t.createdAt) dates.push({ id: d, createdAt: t.createdAt, finishedAt: t.finishedAt ?? null, startedAt: t.startedAt ?? null });
}

console.log('--- dirs without task.json ---');
console.log(JSON.stringify(noTaskJson));
console.log('\n--- status distribution (24 dirs) ---');
console.log(JSON.stringify(statusCount));
console.log('\n--- stageStates[].status enum counts ---');
console.log(JSON.stringify(stageStatusCount));
console.log('\n--- stage id names (count) ---');
console.log(JSON.stringify(stageIdNames));
console.log('\n--- workflow usage ---');
console.log(JSON.stringify(wfUse));
console.log('\n--- titles (all tasks: title / description / storyCode / status) ---');
for (const x of titles) console.log(JSON.stringify(x));
console.log('\n--- errors ---');
for (const e of errors) console.log(JSON.stringify(e));
console.log('\n--- tasks with non-empty decisions ---');
console.log(JSON.stringify(decisionsNonEmpty, null, 1));
console.log('\n--- humanState entries ---');
for (const h of humanStates) console.log(JSON.stringify(h));
console.log('\n--- tasks with inputs ---');
for (const i of inputsTasks) console.log(JSON.stringify(i));
console.log('\n--- createdAt timeline ---');
dates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
console.log('first', JSON.stringify(dates[0]), '\nlast ', JSON.stringify(dates[dates.length - 1]), '\nn=', dates.length);
console.log('\n--- field-count histogram ---');
console.log(JSON.stringify(fieldsByTaskCount));

// stage artifact shape
console.log('\n--- stage artifact sample ---');
for (const d of dirs.slice(0, 24)) {
  const sd = path.join(ROOT, d, 'stages');
  if (!fs.existsSync(sd)) continue;
  const f = fs.readdirSync(sd).find(x => x.endsWith('.json'));
  if (!f) continue;
  const a = readJson(path.join(sd, f));
  console.log('file', d + '/' + f, '| keys:', Object.keys(a).join(','));
  for (const [k, v] of Object.entries(a)) {
    const r = JSON.stringify(v); console.log('   ', k, '=', r.length > 200 ? r.slice(0, 200) + `...(+${r.length - 200})` : r);
  }
  break;
}
