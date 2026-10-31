import fs from 'node:fs';

const P = 'C:/Users/MrYang/.dsh/dev-orchestrator/workflows.json';
const raw = fs.readFileSync(P, 'utf8');
console.log('bytes', Buffer.byteLength(raw), 'chars', raw.length);
let data = JSON.parse(raw);
console.log('topLevelType', Array.isArray(data) ? 'array' : typeof data);
if (!Array.isArray(data) && data && typeof data === 'object') {
  console.log('topKeys', Object.keys(data));
  // find array-ish
  for (const [k, v] of Object.entries(data)) {
    console.log('  key', k, Array.isArray(v) ? `array(${v.length})` : typeof v);
  }
}
const wfs = Array.isArray(data) ? data : (data.workflows ?? data.items ?? []);
console.log('workflowCount', wfs.length);
if (!wfs.length) process.exit(0);

const wf0 = wfs[0];
console.log('\n--- workflow record keys ---');
console.log(Object.keys(wf0).join(', '));
console.log('\n--- per workflow ---');
for (const w of wfs) {
  const nodes = w.nodes ?? [];
  const edges = w.edges ?? [];
  const stages = w.stages ?? [];
  const typeCount = {};
  for (const n of nodes) { const t = n.type ?? n.kind ?? '?'; typeCount[t] = (typeCount[t] ?? 0) + 1; }
  console.log(JSON.stringify({
    id: w.id,
    name: w.name,
    desc: (w.description ?? '').slice(0, 40),
    nodes: nodes.length,
    edges: edges.length,
    stages: stages.length,
    types: typeCount,
    inputs: Array.isArray(w.inputs) ? w.inputs.map(i => `${i.name}:${i.type}${i.required ? '!' : ''}`) : undefined,
    keys: Object.keys(w).join('|'),
    updatedAt: w.updatedAt ?? w.createdAt ?? null,
  }));
}
console.log('\n--- node keys union ---');
const nk = new Set(); for (const w of wfs) for (const n of (w.nodes ?? [])) Object.keys(n).forEach(k => nk.add(k));
console.log([...nk].join(', '));
console.log('\n--- all node types (union) ---');
const allT = {}; for (const w of wfs) for (const n of (w.nodes ?? [])) { const t = n.type ?? n.kind ?? '?'; allT[t] = (allT[t] ?? 0) + 1; }
console.log(JSON.stringify(allT));
console.log('\n--- sample node (first workflow, first 3 nodes) ---');
for (const n of (wfs[0].nodes ?? []).slice(0, 3)) console.log(JSON.stringify(n).slice(0, 400));
console.log('\n--- sample edge (first 2) ---');
for (const e of (wfs[0].edges ?? []).slice(0, 2)) console.log(JSON.stringify(e).slice(0, 300));
