import { readFileSync, writeFileSync } from 'node:fs';
const j = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const nr = j.normalized_result || {};
const out = {
  evidence_id: j.evidence_id,
  subject: j.subject,
  provider: j.provider,
  operation: j.operation,
  parameters: j.parameters,
  confidence: j.confidence,
  authority: j.authority,
  environment: j.environment,
  predicate_type: j.predicate_type,
  relationship_coverage: j.relationship_coverage,
  limitations: j.limitations,
  locations: j.locations,
  normalized_result_keys: Object.keys(nr),
};
for (const k of Object.keys(nr)) {
  const v = nr[k];
  if (Array.isArray(v)) out[`nr.${k}`] = `array(${v.length})`;
  else if (v && typeof v === 'object') out[`nr.${k}`] = `object[${Object.keys(v).join(',')}]`;
  else out[`nr.${k}`] = v;
}
// modules / files inventory
const modules = nr.modules || nr.files || nr.artifacts || [];
if (Array.isArray(modules) && modules.length) {
  out.moduleCount = modules.length;
  out.modules = modules.map((m) => ({
    id: m.id,
    path: m.path || m.file || m.relativePath,
    kind: m.kind || m.role || m.type,
    lines: m.lineCount ?? m.lines,
    exportsCount: Array.isArray(m.exports) ? m.exports.length : undefined,
    importsCount: Array.isArray(m.imports) ? m.imports.length : undefined,
  }));
}
// count relationship / edge arrays generically
const edgesKeys = Object.keys(nr).filter((k) => /edge|relationship|import|export|call|symbol|node/i.test(k));
out.edgeArrays = {};
for (const k of edgesKeys) {
  const v = nr[k];
  if (Array.isArray(v)) out.edgeArrays[k] = v.length;
  else if (v && typeof v === 'object') out.edgeArrays[k] = Object.keys(v).length;
}
writeFileSync(process.argv[3], JSON.stringify(out, null, 2), 'utf8');
console.log('ok', process.argv[3]);
