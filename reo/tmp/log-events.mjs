import fs from 'node:fs';

const P = 'C:/Users/MrYang/.dsh/dev-orchestrator/knj-host-debug.log';
const lines = fs.readFileSync(P, 'utf8').split(/\r?\n/).filter(Boolean);
const events = {}, eventErr = {}, errorsByMsg = {}, byDay = {};
const tasksSeen = new Set(), assistIds = new Set(), runIds = new Set();
const samples = {};
let parseFail = 0;

for (const l of lines) {
  let o; try { o = JSON.parse(l); } catch { parseFail++; continue; }
  const ev = o.event ?? '(no-event)';
  events[ev] = (events[ev] ?? 0) + 1;
  if (!samples[ev]) samples[ev] = JSON.stringify(o).slice(0, 230);
  if (o.taskId) tasksSeen.add(o.taskId);
  if (o.requestId) assistIds.add(o.requestId);
  if (o.runId) runIds.add(o.runId);
  if (o.error) {
    eventErr[ev] = (eventErr[ev] ?? 0) + 1;
    const k = ev + ' :: ' + String(o.error).slice(0, 120);
    errorsByMsg[k] = (errorsByMsg[k] ?? 0) + 1;
  }
  const day = String(o.ts ?? '').slice(0, 10);
  if (day) byDay[day] = (byDay[day] ?? 0) + 1;
}
console.log('lines', lines.length, 'parseFail', parseFail);
console.log('distinctEvents', Object.keys(events).length, 'distinctTaskIds', tasksSeen.size, 'distinctAssistRequestIds', assistIds.size, 'distinctRunIds', runIds.size);
console.log('\n--- top 45 events ---');
Object.entries(events).sort((a, b) => b[1] - a[1]).slice(0, 45).forEach(([k, v]) => console.log(String(v).padStart(6), k));
console.log('\n--- events with error counts ---');
Object.entries(eventErr).sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, v]) => console.log(String(v).padStart(6), k));
console.log('\n--- top 22 error messages (event :: error) ---');
Object.entries(errorsByMsg).sort((a, b) => b[1] - a[1]).slice(0, 22).forEach(([k, v]) => console.log(String(v).padStart(6), k));
console.log('\n--- activity by day (all) ---');
Object.entries(byDay).sort().forEach(([d, n]) => console.log(d, n));
console.log('\n--- one sample line per notable event ---');
for (const ev of Object.keys(events)) {
  if (/assist|startTask|decide|human|stage|resume|rerun|error|失败|Scheduler|schedule|upload|materialize|requirement/i.test(ev))
    console.log(ev, '=>', samples[ev]);
}
