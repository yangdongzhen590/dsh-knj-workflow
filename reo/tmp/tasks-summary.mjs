import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/MrYang/.dsh/dev-orchestrator/tasks';
const dirs = fs.readdirSync(ROOT).filter(d => fs.statSync(path.join(ROOT, d)).isDirectory());
console.log('taskDirCount', dirs.length);

const rows = [];
const statusCount = {};
const fieldSet = new Set();
let totalStageFiles = 0;
const stageArtifactFiles = new Set();
const reqLens = [];
let totalReqChars = 0, withReqMd = 0, archived = 0;
const perTask = [];

for (const d of dirs) {
  const tdir = path.join(ROOT, d);
  const tjson = path.join(tdir, 'task.json');
  let t = null;
  if (fs.existsSync(tjson)) {
    try { t = JSON.parse(fs.readFileSync(tjson, 'utf8')); } catch (e) { console.log('PARSE FAIL', d, e.message); }
  }
  const files = fs.readdirSync(tdir);
  const hasReq = files.includes('requirement.md');
  if (hasReq) { withReqMd++; totalReqChars += fs.readFileSync(path.join(tdir, 'requirement.md'), 'utf8').length; }
  const stagesDir = path.join(tdir, 'stages');
  let stageFiles = [];
  if (fs.existsSync(stagesDir)) {
    stageFiles = fs.readdirSync(stagesDir).filter(f => f.endsWith('.json'));
    totalStageFiles += stageFiles.length;
    stageFiles.forEach(f => stageArtifactFiles.add(f));
  }
  if (!t) { rows.push({ id: d, status: 'NO_TASK_JSON', files: files.join(',') }); continue; }
  Object.keys(t).forEach(k => fieldSet.add(k));
  const st = t.status ?? '(none)';
  statusCount[st] = (statusCount[st] ?? 0) + 1;
  if (t.archived) archived++;
  const desc = t.description ?? t.inputDescription ?? '';
  reqLens.push(desc.length);
  const stageStates = t.stages ?? t.stageStates ?? [];
  const stageStatusCount = {};
  if (Array.isArray(stageStates)) for (const s of stageStates) { const k = s.status ?? '?'; stageStatusCount[k] = (stageStatusCount[k] ?? 0) + 1; }
  perTask.push({
    id: d, status: st, archived: !!t.archived, wf: t.workflowId ?? t.workflow_id,
    titleLen: (t.title ?? '').length, descChars: desc.length,
    stages: Array.isArray(stageStates) ? stageStates.length : 0,
    stageStatus: stageStatusCount, stageFiles: stageFiles.length, hasReqMd: hasReq,
    storyCode: t.storyCode ?? null, model: t.model ?? null,
    keys: Object.keys(t).length,
  });
}

console.log('\n--- task.json field union (all keys) ---');
console.log([...fieldSet].sort().join(', '));

console.log('\n--- status distribution ---');
console.log(JSON.stringify(statusCount, null, 0));

console.log('\n--- misc ---');
console.log(JSON.stringify({ withReqMd, archivedCount: archived, totalStageJsonFiles: totalStageFiles, distinctStageFileNames: [...stageArtifactFiles].join('|') }));

reqLens.sort((a, b) => a - b);
const sum = reqLens.reduce((a, b) => a + b, 0);
console.log('\n--- requirement description length (chars) ---');
console.log(JSON.stringify({
  n: reqLens.length, min: reqLens[0], p25: reqLens[Math.floor(reqLens.length * 0.25)],
  median: reqLens[Math.floor(reqLens.length / 2)], p75: reqLens[Math.floor(reqLens.length * 0.75)],
  max: reqLens[reqLens.length - 1], mean: Math.round(sum / reqLens.length), sum,
}));

console.log('\n--- per task ---');
for (const r of perTask.sort((a, b) => b.descChars - a.descChars)) console.log(JSON.stringify(r));

console.log('\n--- a full sample task.json (keys + small values, first task w/ stages) ---');
const sample = perTask.find(p => p.stages > 0) ?? perTask[0];
const sT = JSON.parse(fs.readFileSync(path.join(ROOT, sample.id, 'task.json'), 'utf8'));
for (const [k, v] of Object.entries(sT)) {
  const repr = JSON.stringify(v);
  console.log(k, '=', repr.length > 220 ? repr.slice(0, 220) + `...(+${repr.length - 220})` : repr);
}
