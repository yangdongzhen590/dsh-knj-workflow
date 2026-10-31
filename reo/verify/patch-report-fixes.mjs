// 把三条修复同步进 HTML 报告（精确串替换，命中数必须为 1）
import { readFileSync, writeFileSync } from 'node:fs';

const FIX_TAG = '<span class="tag t">已修复 2026-10-24</span>';

const patches = [
  // ---- 英雄区指标 ----
  ['reo/html/part1.html',
    '<div class="stat"><span class="v">24</span><span class="k">HTTP 路由<br>README 只写了 12</span></div>',
    '<div class="stat"><span class="v">25</span><span class="k">HTTP 路由<br>24 + 1 发现端点</span></div>'],
  ['reo/html/part1.html',
    '<div class="stat"><span class="v">389</span><span class="k">测试用例<br>3.9s 全绿</span></div>',
    '<div class="stat"><span class="v">407</span><span class="k">测试用例<br>3.8s 全绿</span></div>'],
  ['reo/html/part5.html',
    '<div class="stat"><span class="v">389</span><span class="k">用例<br>全绿</span></div>',
    '<div class="stat"><span class="v">407</span><span class="k">用例<br>全绿</span></div>'],

  // ---- 00 章：追加修复记录 ----
  ['reo/html/part2.html',
    '复核脚本：<code>reo/verify/verify.mjs</code>、<code>verify2.mjs</code>。</p>\n  </div>',
    `复核脚本：<code>reo/verify/verify.mjs</code>、<code>verify2.mjs</code>。</p>
  </div>

  <div class="callout g">
    <span class="ct">修复记录 · 2026-10-24 23:20（定稿后落地）</span>
    <p style="font-size:13px">按确认范围落了三条修复，每条都先写红测试再改实现；全量套件 <b>407/407 绿</b>（原 389 + 新增 18），<code>git</code> 里未提交的仍是原有那批改动 + 本次新增。</p>
    <ul style="font-size:13px;margin:6px 0 4px">
      <li><b>① /dev-task 命令契约</b>：<code>lib/index.js</code> 同时提供 <code>handler(invocation)</code>（0.2.x，返回 <code>{kind,text}</code>）与 <code>execute(line)</code>（0.1.x，返回 <code>{success,text}</code>），注册不再抛 <code>TypeError</code>。测试：<code>lib/commands-contract.test.js</code>（8 例，内含两代宿主的校验器与源码守卫）。</li>
      <li><b>② 前缀发现</b>：Host 新增固定只读端点 <code>GET /knj-workflow/meta</code> → <code>{plugin,prefix}</code>（注册在前缀路由之后，不抢占 <code>registrations[0]</code>；旧宿主不支持 <code>exact</code> 路由时降级且不影响插件）；客户端 <code>resolvePrefix</code> 启动探测一次并缓存，404/异常/非法值回退 <code>/devtask</code>。测试：<code>lib/prefix-discovery.test.js</code>（6 例）。</li>
      <li><b>③ JSON 损坏隔离</b>：<code>readJson</code> 解析失败时把原文件改名为 <code>&lt;name&gt;.corrupt-&lt;ts&gt;</code> 并记诊断日志，不再静默 fallback 后被默认流水线覆盖；同时剥离 UTF-8 BOM（真实数据里 1 个 <code>task.json</code> 因此静默消失）。测试：<code>lib/store-resilience.test.js</code>（4 例）。</li>
    </ul>
    <p style="font-size:13px;margin:6px 0 0">同步更新 <code>README.md</code>：API 表补齐到 24 条 + 发现端点说明、编排器参数改为实际消费的 <code>args</code>、配置表补 <code>orchestratorScript</code> 与前缀自发现说明。<b>未做</b>：版本号、打包、安装 —— 需按发布节奏 <code>pnpm pack</code> 并重装后才会在运行中的 GUI 生效。</p>
  </div>`],

  // ---- 03 章 F11 坑 ----
  ['reo/html/part4.html',
    '<span class="ev ev-run">运行证据</span> <code>/dev-task</code> 命令在 DSH 0.2.1 上<b>注册失败</b>',
    `<span class="ev ev-run">运行证据</span> <code>/dev-task</code> 命令在 DSH 0.2.1 上<b>注册失败</b> ${FIX_TAG}`],

  // ---- 04 章 P0 前缀 ----
  ['reo/html/part5.html',
    '<b>客户端写死 <code>PREFIX = \'/devtask\'</code></b>（<code>client.js:16</code>）',
    `<b>客户端写死 <code>PREFIX = '/devtask'</code></b>（<code>client.js:16</code>）${FIX_TAG}`],

  // ---- 04 章 P1 readJson ----
  ['reo/html/part5.html',
    '<b>损坏 JSON 静默重置</b>：<code>readJson</code> 任何异常返回 fallback',
    `<b>损坏 JSON 静默重置</b>${FIX_TAG}：<code>readJson</code> 任何异常返回 fallback`],

  // ---- 05 章风险表 ----
  ['reo/html/part5.html',
    '<code>/dev-task</code> 命令在 0.2.x 上<b>注册即失败</b></td>',
    `<code>/dev-task</code> 命令在 0.2.x 上<b>注册即失败</b> ${FIX_TAG}</td>`],
  ['reo/html/part5.html',
    '<td>损坏 JSON 静默重置 / 丢数据</td>',
    `<td>损坏 JSON 静默重置 / 丢数据 ${FIX_TAG}</td>`],
];

for (const [file, from, to] of patches) {
  const src = readFileSync(file, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) { console.error(`MISS(${n}) ${file}: ${from.slice(0, 70)}`); process.exitCode = 1; continue; }
  writeFileSync(file, src.split(from).join(to), 'utf8');
  console.log(`ok ${file}: ${from.slice(0, 44)}…`);
}
