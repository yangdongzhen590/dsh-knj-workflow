// 用最新复核数据刷新报告中的数字口径（精确串替换，命中数必须为 1）
import { readFileSync, writeFileSync } from 'node:fs';

const patches = [
  ['reo/html/part2.html',
    'README 有 4 处与实现对不上（API 表缺 12 条、',
    'README 有 4 处与实现对不上（API 表漏 8 条、'],
  ['reo/html/part2.html',
    '3MB 日志里只有 <b>5.3%</b> 属于真实任务，其余来自 481 个测试夹具 taskId。',
    '3.25MB 日志里只有 <b>4.9%</b> 的行属于真实任务，其余来自测试夹具 taskId（551 个不同 taskId 混在一起）。'],
  ['reo/html/part2.html',
    '（8 工作流 / 23 任务 / 3MB 诊断日志）',
    '（8 工作流 / 23 任务 / 3.2MB 诊断日志）'],
  ['reo/html/part2.html',
    '<div class="stat"><span class="v">406</span><span class="k">AI 改流程请求<br>跨 9 个活跃日</span></div>',
    '<div class="stat"><span class="v">433</span><span class="k">AI 改流程请求<br>跨 9 个活跃日</span></div>'],
  ['reo/html/part2.html',
    '<div class="stat"><span class="v">5.3<small>%</small></span><span class="k">诊断日志里<br>真实任务占比</span></div>',
    '<div class="stat"><span class="v">4.9<small>%</small></span><span class="k">诊断日志里<br>真实任务占比</span></div>'],
  ['reo/html/part2.html',
    'requirement.md 落盘 <b>0</b> 次 · 声明式文件入参 <b>0</b> 例 · 归档 <b>0</b> 次</td><td>主打的长需求/文件入参/归档功能，在真实数据里<b>从未被触发</b>',
    'requirement.md 落盘 <b>0</b> 次 · 声明式文件入参 <b>0</b> 例 · 归档 <b>1</b> 次</td><td>主打的长需求/文件入参<b>从未被触发</b>，归档仅 1 次'],
  ['reo/html/part2.html',
    '真实需求最长只有 <b>5 个字</b>，中位数 2 个字。所以「用了 406 次 AI 改流程」是真的',
    '真实需求最长只有 <b>28 个字</b>，中位数 2 个字。所以「用了 433 次 AI 改流程」是真的'],
  ['reo/html/part2.html',
    'README 列 12 条，代码注册 <b>24 条</b>。',
    'README 表 11 行、只覆盖 16 条，代码注册 <b>24 条</b>。'],
  ['reo/html/part4.html',
    '真实 406 次请求里 <b>206 次（51%）</b>降级',
    '真实 433 次请求里 <b>220 次（51%）</b>降级'],
  ['reo/html/part4.html',
    '真实 23 个任务里需求最长 5 字、4 个空需求',
    '真实 23 个任务里需求最长 28 字、4 个空需求'],
  ['reo/html/part5.html',
    '实测 3.1 MB / 2.5 万行且仍在增长；真实任务只占 5.3%。',
    '实测 3.25 MB / 2.58 万行且仍在增长；真实任务只占 4.9%。'],
];

for (const [file, from, to] of patches) {
  const src = readFileSync(file, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) { console.error(`MISS(${n}) ${file}: ${from.slice(0, 60)}`); process.exitCode = 1; continue; }
  writeFileSync(file, src.split(from).join(to), 'utf8');
  console.log(`ok ${file}: ${from.slice(0, 48)}…`);
}
