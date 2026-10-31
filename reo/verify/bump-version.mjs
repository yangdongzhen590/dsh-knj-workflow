import { readFileSync, writeFileSync } from 'node:fs';
const p = 'package.json';
const s = readFileSync(p, 'utf8');
const FROM = '"version": "2026.10.218"';
const TO = '"version": "2026.10.219"';
const n = s.split(FROM).length - 1;
if (n !== 1) { console.error('MISS', n); process.exit(1); }
writeFileSync(p, s.split(FROM).join(TO), 'utf8');
const after = JSON.parse(readFileSync(p, 'utf8'));
console.log('version ->', after.version);
