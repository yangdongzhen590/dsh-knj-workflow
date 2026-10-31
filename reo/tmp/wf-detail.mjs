import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('C:/Users/MrYang/.dsh/dev-orchestrator/workflows.json', 'utf8'));
const wf = data.workflows.find(w => w.id === 'wf-dev-flow');
console.log('workflow:', wf.id, wf.name, '| schemaVersion', wf.schemaVersion, '| revision', wf.revision);
console.log('description:', wf.description);
console.log('\nnodes:');
for (const n of wf.nodes) {
  const b = n.body || {};
  const out = b.output ? Object.keys(b.output.properties ?? {}).map(k => `${k}:${b.output.properties[k].type}${b.output.properties[k].enum ? '[' + b.output.properties[k].enum.join('|') + ']' : ''}`).join(', ') : '';
  console.log(JSON.stringify({
    id: n.id, type: n.type, title: n.title, x: Math.round(n.x), y: Math.round(n.y),
    mode: b.mode, skill: b.skill ?? null, maxRuns: n.maxRuns ?? null,
    action: n.action ?? null, displayFrom: n.displayFrom ?? null,
    routes: n.routes ?? null, promptChars: (b.prompt ?? '').length, output: out,
  }));
}
console.log('\nedges:', JSON.stringify(wf.edges));
console.log('\n--- all workflows: node type x count, inputs, revision ---');
for (const w of data.workflows) {
  const tc = {}; for (const n of w.nodes) tc[n.type] = (tc[n.type] ?? 0) + 1;
  const prompts = w.nodes.filter(n => n.type === 'task').map(n => (n.body?.prompt ?? '').length);
  const skills = w.nodes.filter(n => n.body?.skill).map(n => `${n.id}:${n.body.skill}`);
  console.log(`${w.id}\t${w.name}\tschema=${w.schemaVersion}\trev=${w.revision}\tnodes=${w.nodes.length}\t${JSON.stringify(tc)}\tpromptChars=[${prompts.join(',')}]\tskills=[${skills.join(',')}]\tinputs=${(w.inputs ?? []).length}`);
}
