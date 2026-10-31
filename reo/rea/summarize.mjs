// Summarize the huge REA analyze-javascript-application JSON without loading it all into memory.
// Reads the file as a stream-ish whole string is 233MB -> acceptable once, but we avoid re-serializing.
import { readFileSync, writeFileSync } from 'node:fs';

const p = process.argv[2];
const raw = readFileSync(p, 'utf8');
const j = JSON.parse(raw);

const out = {};
out.topLevelKeys = Object.keys(j);
for (const k of Object.keys(j)) {
  const v = j[k];
  if (Array.isArray(v)) out[`${k}.__type`] = `array(${v.length})`;
  else if (v && typeof v === 'object') out[`${k}.__type`] = `object(${Object.keys(v).length} keys)`;
  else out[`${k}.__type`] = typeof v;
}

// evidence / findings
const ev = j.evidence || j.result?.evidence || {};
out.evidenceKeys = ev && typeof ev === 'object' ? Object.keys(ev) : typeof ev;
const findings = (j.findings || ev.findings || j.result?.findings || []);
out.findingsCount = Array.isArray(findings) ? findings.length : 'n/a';
out.findingsSample = Array.isArray(findings) ? findings.slice(0, 12) : findings;

const limitations = j.limitations || ev.limitations || j.result?.limitations;
out.limitations = limitations;

const unknowns = j.unknowns || ev.unknowns || j.result?.unknowns;
out.unknowns = unknowns;

// graph / modules
const g = j.graph || j.result?.graph || {};
out.graphKeys = g && typeof g === 'object' ? Object.keys(g) : typeof g;
const mods = g.modules || g.nodes || [];
out.moduleCount = Array.isArray(mods) ? mods.length : 'n/a';
out.moduleSample = Array.isArray(mods) ? mods.slice(0, 3) : mods;

// identity
out.identity = j.identity || j.target || j.result?.identity || null;

writeFileSync(process.argv[3], JSON.stringify(out, null, 2), 'utf8');
console.log('wrote summary', process.argv[3]);
