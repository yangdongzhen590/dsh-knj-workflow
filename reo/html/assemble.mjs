import { readFileSync, writeFileSync } from 'node:fs';

const parts = ['part1', 'part2', 'part3', 'part4', 'part5'].map((p) =>
  readFileSync(`reo/html/${p}.html`, 'utf8'),
);
let html = parts.join('\n');

const shots = {
  __SHOT_EDITOR__: 'assets/screenshots/workflow-editor.png',
  __SHOT_MODAL__: 'assets/screenshots/new-task-modal.png',
};
for (const [ph, file] of Object.entries(shots)) {
  const b64 = readFileSync(file).toString('base64');
  html = html.split(ph).join(`data:image/png;base64,${b64}`);
}

const out = 'dsh-knj-workflow-REA-report.html';
writeFileSync(out, html, 'utf8');

// structural sanity checks
const counts = {};
for (const tag of ['section', 'div', 'article', 'table', 'figure', 'details', 'svg', 'main', 'aside', 'header', 'style', 'script', 'pre', 'code']) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  counts[tag] = { open, close, ok: open === close };
}
console.log('bytes:', Buffer.byteLength(html), 'lines:', html.split('\n').length);
console.log(JSON.stringify(counts, null, 0));
const bad = Object.entries(counts).filter(([, v]) => !v.ok);
console.log(bad.length ? 'MISMATCHED: ' + JSON.stringify(bad) : 'all tags balanced');
console.log('shot placeholders left:', (html.match(/__SHOT_/g) || []).length);
