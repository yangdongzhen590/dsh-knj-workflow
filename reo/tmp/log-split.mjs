import fs from 'node:fs';

const P = 'C:/Users/MrYang/.dsh/dev-orchestrator/knj-host-debug.log';
const ROOT = 'C:/Users/MrYang/.dsh/dev-orchestrator/tasks';
const realIds = new Set(fs.readdirSync(ROOT));
const lines = fs.readFileSync(P, 'utf8').split(/\r?\n/).filter(Boolean);

const bucket = { real: { lines: 0, events: {}, errors: {} }, fixture: { lines: 0, events: {}, errors: {} } };
const realTaskIdsSeen = new Set(), fixtureIds = new Set();
for (const l of lines) {
  const o = JSON.parse(l);
  const id = o.taskId;
  const isReal = !!id && realIds.has(id);
  const b = isReal ? bucket.real : bucket.fixture;
  b.lines++;
  if (id) (isReal ? realTaskIdsSeen : fixtureIds).add(id);
  const ev = o.event ?? '?';
  b.events[ev] = (b.events[ev] ?? 0) + 1;
  if (o.error) b.errors[ev + ' :: ' + String(o.error).slice(0, 100)] = (b.errors[ev + ' :: ' + String(o.error).slice(0, 100)] ?? 0) + 1;
}
for (const k of ['real', 'fixture']) {
  const b = bucket[k];
  console.log(`\n===== ${k} : lines=${b.lines} distinctTaskIds=${k === 'real' ? realTaskIdsSeen.size : fixtureIds.size} =====`);
  console.log('events:', JSON.stringify(Object.fromEntries(Object.entries(b.events).sort((a, z) => z[1] - a[1]))));
  console.log('errors:', JSON.stringify(Object.fromEntries(Object.entries(b.errors).sort((a, z) => z[1] - a[1]).slice(0, 12)), null, 1));
}
console.log('\nrealIdsSeen:', [...realTaskIdsSeen].sort().join(','));
console.log('\nfixtureIds sample (first 30):', [...fixtureIds].slice(0, 30).join(','));
