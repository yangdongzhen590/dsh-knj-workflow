import fs from 'node:fs';
import path from 'node:path';
const ROOT = 'C:/Users/MrYang/.dsh/dev-orchestrator/tasks';
const read = p => { let s = fs.readFileSync(p, 'utf8'); if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); return JSON.parse(s); };
const decLabels = {}, cwdCount = {};
let decTotal = 0, titleEqDesc = 0, titleTimestamp = 0, emptyDesc = 0, n = 0;
for (const d of fs.readdirSync(ROOT)) {
  const f = path.join(ROOT, d, 'task.json'); if (!fs.existsSync(f)) continue;
  const t = read(f); n++;
  for (const x of (t.decisions ?? [])) { decLabels[x.decision] = (decLabels[x.decision] ?? 0) + 1; decTotal++; }
  const c = t.cwd ?? '(none)'; cwdCount[c] = (cwdCount[c] ?? 0) + 1;
  if (!t.description) emptyDesc++; else if (t.title === t.description) titleEqDesc++; else console.log('title!=desc:', d, JSON.stringify(t.title), JSON.stringify(t.description));
  if (/^未命名任务 \d{2}-\d{2} \d{2}:\d{2}$/.test(t.title ?? '')) titleTimestamp++;
}
console.log('tasks', n, '| decisions total', decTotal, JSON.stringify(decLabels));
console.log('title==description', titleEqDesc, '| timestampPlaceholderTitle', titleTimestamp, '| emptyDescription', emptyDesc);
console.log('cwd distribution', JSON.stringify(cwdCount));
