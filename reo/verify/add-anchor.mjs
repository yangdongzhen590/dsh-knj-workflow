import { readFileSync, writeFileSync } from 'node:fs';
const f = 'reo/html/part2.html';
const from = '<div class="callout g">\n    <span class="ct">修复记录 · 2026-10-24 23:20（定稿后落地）</span>';
const to = '<div class="callout g" id="fix-log">\n    <span class="ct">修复记录 · 2026-10-24 23:20（定稿后落地）</span>';
const s = readFileSync(f, 'utf8');
const n = s.split(from).length - 1;
if (n !== 1) { console.error('MISS', n); process.exit(1); }
writeFileSync(f, s.split(from).join(to), 'utf8');
console.log('ok add id=fix-log');
