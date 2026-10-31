import fs from 'node:fs';
import readline from 'node:readline';

const P = 'C:/Users/MrYang/.dsh/dev-orchestrator/knj-host-debug.log';
const size = fs.statSync(P).size;
const lines = fs.readFileSync(P, 'utf8').split(/\r?\n/);
console.log('bytes', size, 'lines', lines.length);
console.log('\n--- first 5 lines (truncated 240) ---');
lines.slice(0, 5).forEach((l, i) => console.log(i, l.slice(0, 240)));
console.log('\n--- last 5 lines (truncated 240) ---');
lines.slice(-5).forEach((l, i) => console.log(lines.length - 5 + i, l.slice(0, 240)));

// route stats
const routeRe = /(GET|POST|PUT|DELETE|PATCH)\s+(\S+)/g;
const routes = {};
const statuses = {};
const errLines = [];
let errCount = 0;
for (const l of lines) {
  let m;
  routeRe.lastIndex = 0;
  while ((m = routeRe.exec(l))) {
    const key = m[1] + ' ' + m[2].split('?')[0].replace(/task-m[a-z0-9-]+/g, ':id').replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, ':uuid');
    routes[key] = (routes[key] ?? 0) + 1;
  }
  const sm = l.match(/\b(200|201|202|204|400|401|403|404|409|500|502)\b/);
  if (sm && /\b(devtask|status|http)\b|\d{3}\s*$/.test(l)) statuses[sm[1]] = (statuses[sm[1]] ?? 0) + 1;
  if (/\b(ERROR|Error:|error=|失败|EADDR|ECONN|unhandled|Unhandled|stack)\b/.test(l)) { errCount++; if (errLines.length < 4000) errLines.push(l); }
}
console.log('\n--- top 40 routes ---');
Object.entries(routes).sort((a, b) => b[1] - a[1]).slice(0, 40).forEach(([k, v]) => console.log(v, k));
console.log('\n--- log levels / prefixes histogram (first token-ish) ---');
const prefix = {};
for (const l of lines) {
  const m = l.match(/^\[([^\]]{0,30})\]|^(\d{4}-\d{2}-\d{2}[T ][\d:.]+)/);
  const k = m ? (m[1] ?? 'ISO') : (l.slice(0, 12) || '(empty)');
  prefix[k] = (prefix[k] ?? 0) + 1;
}
Object.entries(prefix).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, v]) => console.log(v, JSON.stringify(k)));

console.log('\n--- error-ish line count ---', errCount);
// normalize error messages
const norm = {};
for (const l of errLines) {
  let s = l.replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<ts>').replace(/task-m[a-z0-9]+/g, '<task>').replace(/\b\d+\b/g, 'N');
  norm[s.slice(0, 200)] = (norm[s.slice(0, 200)] ?? 0) + 1;
}
console.log('--- top 15 normalized error-ish lines ---');
Object.entries(norm).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(v, k));
