import fs from 'node:fs';
import path from 'node:path';
const ROOT = 'C:/Users/MrYang/.dsh/dev-orchestrator/tasks';
const read = p => { let s = fs.readFileSync(p, 'utf8'); if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); return JSON.parse(s); };
const out = [];
for (const d of fs.readdirSync(ROOT)) {
  const f = path.join(ROOT, d, 'task.json');
  if (!fs.existsSync(f)) continue;
  const t = read(f);
  const start = t.startedAt ? Date.parse(t.startedAt) : null;
  const fin = t.finishedAt ? Date.parse(t.finishedAt) : null;
  const stages = (t.stageStates ?? []).map(s => ({
    id: s.id, st: s.status,
    dur: s.startedAt && s.finishedAt ? Math.round((Date.parse(s.finishedAt) - Date.parse(s.startedAt)) / 1000) : null,
    sessions: (s.sessionIds ?? []).length,
  }));
  out.push({ id: d, status: t.status, wf: t.workflowId, totalSec: start && fin ? Math.round((fin - start) / 1000) : null, stageCount: stages.length, stages });
}
const totSec = out.filter(o => o.totalSec != null).map(o => o.totalSec).sort((a, b) => a - b);
console.log('--- tasks with measured wall time ---');
console.log('n=', totSec.length, 'min=', totSec[0], 'median=', totSec[Math.floor(totSec.length / 2)], 'max=', totSec.at(-1), 'sumSec=', totSec.reduce((a, b) => a + b, 0));
console.log('\n--- per task stage durations (sec) ---');
for (const o of out) console.log(o.id, o.status, o.wf, 'total=' + o.totalSec + 's', '|', o.stages.map(s => `${s.id}:${s.st}:${s.dur}s/x${s.sessions}`).join('  '));
console.log('\n--- distinct stage ids used across real tasks w/ counts ---');
const ids = {};
for (const o of out) for (const s of o.stages) ids[s.id] = (ids[s.id] ?? 0) + 1;
console.log(JSON.stringify(Object.fromEntries(Object.entries(ids).sort((a, b) => b[1] - a[1]))));
console.log('\n--- total session spawns (stage x sessionIds) ---');
let spawn = 0, spawnDone = 0;
for (const o of out) for (const s of o.stages) if (s.st !== 'skipped' && s.st !== 'pending') { spawn += s.sessions; spawnDone++; }
console.log('executedStages', spawnDone, 'sessionsSpawned', spawn);
