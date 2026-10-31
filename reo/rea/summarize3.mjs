import { readFileSync, writeFileSync } from 'node:fs';
const j = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const nr = j.normalized_result || {};
const st = nr.statistics || {};
const g = nr.graph || {};
const sg = nr.semantic_graph || {};
const out = {
  evidence_id: j.evidence_id,
  confidence: j.confidence,
  authority: j.authority,
  root_artifact_sha256: nr.root_artifact_sha256,
  statistics: st,
  graph: {
    nodeCount: Array.isArray(g.nodes) ? g.nodes.length : null,
    edgeCount: Array.isArray(g.edges) ? g.edges.length : null,
    rootNodeIds: g.root_node_ids,
    coverage: g.coverage,
    limitations: g.limitations,
  },
  semantic_graph: {
    nodeCount: Array.isArray(sg.nodes) ? sg.nodes.length : null,
    relationCount: Array.isArray(sg.relations) ? sg.relations.length : null,
    coverage: sg.coverage,
    unknowns: sg.unknowns,
    rootNodeIds: sg.root_node_ids,
  },
};
// per-file module facts
const nodes = (sg.nodes || []).map((n) => ({
  id: n.id, kind: n.kind || n.type, name: n.name,
  path: n.path || n.location?.path, digest: n.digest?.sha256 || n.sha256,
}));
out.semanticNodes = nodes.slice(0, 60);
const relations = (sg.relations || []);
const relKinds = {};
for (const r of relations) relKinds[r.kind || r.type] = (relKinds[r.kind || r.type] || 0) + 1;
out.relationKinds = relKinds;
out.relationSample = relations.slice(0, 8);
writeFileSync(process.argv[3], JSON.stringify(out, null, 2), 'utf8');
console.log('ok');
