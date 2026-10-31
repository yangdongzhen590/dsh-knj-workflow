import fs from 'node:fs';
const lines = fs.readFileSync('C:/Users/MrYang/.dsh/dev-orchestrator/knj-host-debug.log', 'utf8').split(/\r?\n/).filter(Boolean);
const reqs = new Map(); // requestId -> {events:Set, degraded:bool, day}
for (const l of lines) {
  const o = JSON.parse(l);
  if (!/assist/i.test(o.event ?? '')) continue;
  const id = o.requestId ?? '(none)';
  const r = reqs.get(id) ?? { events: new Set(), degraded: false, day: String(o.ts).slice(0, 10), failed: false };
  r.events.add(o.event);
  if (/降级/.test(o.event)) r.degraded = true;
  if (o.error) r.failed = true;
  reqs.set(id, r);
}
const byDay = {};
let degraded = 0, failed = 0;
for (const [id, r] of reqs) { byDay[r.day] = (byDay[r.day] ?? 0) + 1; if (r.degraded) degraded++; if (r.failed) failed++; }
console.log('assistRequests(distinct requestId):', reqs.size);
console.log('requestsWithStreamDegradation:', degraded, '(', Math.round(degraded / reqs.size * 100), '%)');
console.log('requestsWithSessionQueryError:', failed);
console.log('byDay:', JSON.stringify(Object.fromEntries(Object.entries(byDay).sort())));
const evHist = {};
for (const [, r] of reqs) for (const e of r.events) evHist[e] = (evHist[e] ?? 0) + 1;
console.log('eventTypes:', JSON.stringify(Object.fromEntries(Object.entries(evHist).sort((a, b) => b[1] - a[1]))));
