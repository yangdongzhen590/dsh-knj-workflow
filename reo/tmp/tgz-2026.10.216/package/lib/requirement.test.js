/**
 * dsh-knj-workflow 需求描述纯函数测试（node:test，零依赖）
 *
 * 覆盖 OpenSpec 变更 update-knj-task-requirement-input 的两条要求：
 *  - Optional requirement description with generated title（标题字段已从表单移除，标题自动生成）
 *  - Large requirement text preservation and bounded prompt injection（超阈值落盘 + 头部摘录 + 文件指针）
 *
 * 运行：node --test lib/requirement.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INLINE_MAX,
  HEAD_MAX,
  REQUIREMENT_FILE_NAME,
  normalizeRequirementText,
  deriveTaskTitle,
  needsRequirementFile,
  formatInputDescription,
  formatThousands,
} from './requirement.js';

// ---------------------------------------------------------------------------
// normalizeRequirementText：粘贴/导入文本规整（不改变语义，只规整空白与不可见字符）
// ---------------------------------------------------------------------------

test('normalize：CRLF/CR 统一为 LF', () => {
  assert.equal(normalizeRequirementText('a\r\nb\rc'), 'a\nb\nc');
});

test('normalize：剥离 BOM 与零宽字符（docx/md 复制常见）', () => {
  assert.equal(normalizeRequirementText('\uFEFF需求\u200B描述\u200D\u2060'), '需求描述');
});

test('normalize：去掉行尾空白、折叠 3+ 连续空行为 1 个空行、整体 trim', () => {
  assert.equal(normalizeRequirementText('  第一行  \n\n\n\n第二行   \n'), '第一行\n\n第二行');
});

test('normalize：非字符串输入安全回落空串', () => {
  assert.equal(normalizeRequirementText(undefined), '');
  assert.equal(normalizeRequirementText(null), '');
});

// ---------------------------------------------------------------------------
// deriveTaskTitle：标题字段移除后的自动生成规则
// ---------------------------------------------------------------------------

test('deriveTaskTitle：取第一条非空行，去掉前导 markdown 井号', () => {
  assert.equal(deriveTaskTitle('## 用户登录优化\n\n详情若干'), '用户登录优化');
  assert.equal(deriveTaskTitle('\n\n   ###   支付回调重试   \n细节'), '支付回调重试');
});

test('deriveTaskTitle：超长首行按真实字符（码点）截断 50，不切碎代理对', () => {
  assert.equal(deriveTaskTitle('a'.repeat(80)), 'a'.repeat(50));
  const emoji = '😀'.repeat(60);
  const t = deriveTaskTitle(emoji);
  assert.equal(Array.from(t).length, 50, '应按码点截断到 50');
  assert.equal(t, '😀'.repeat(50), '不得留下半个代理对（U+FFFD）');
});

test('deriveTaskTitle：描述为空/全空白 → 时间戳占位标题', () => {
  const now = new Date(2026, 8, 1, 14, 30); // 2026-09-01 14:30
  assert.equal(deriveTaskTitle('', now), '未命名任务 09-01 14:30');
  assert.equal(deriveTaskTitle('   \n\t\n', now), '未命名任务 09-01 14:30');
  assert.equal(deriveTaskTitle('##', now), '未命名任务 09-01 14:30', '只有井号的行剥完为空 → 占位标题');
});

// ---------------------------------------------------------------------------
// 阈值判定与注入格式
// ---------------------------------------------------------------------------

test('阈值常量：INLINE_MAX=8000 / HEAD_MAX=6000 / 落盘文件名 requirement.md', () => {
  assert.equal(INLINE_MAX, 8000);
  assert.equal(HEAD_MAX, 6000);
  assert.equal(REQUIREMENT_FILE_NAME, 'requirement.md');
});

test('needsRequirementFile：边界（8000 内联 / 8001 落盘）', () => {
  assert.equal(needsRequirementFile('字'.repeat(INLINE_MAX)), false);
  assert.equal(needsRequirementFile('字'.repeat(INLINE_MAX + 1)), true);
  assert.equal(needsRequirementFile(''), false);
});

test('formatInputDescription：小文本/空描述与旧行为逐字一致', () => {
  assert.equal(formatInputDescription({ description: '做一个批量下载' }), '做一个批量下载');
  assert.equal(formatInputDescription({ description: '' }), '');
  assert.equal(formatInputDescription({}), '');
  assert.equal(formatInputDescription(undefined), '');
  // 规整在注入点也生效（换行不会以 CRLF 形式漏进 prompt）
  assert.equal(formatInputDescription({ description: 'x\r\ny' }), 'x\ny');
});

test('formatInputDescription：超阈值 → 头部摘录 + 省略字数 + 文件指针', () => {
  const desc = '字'.repeat(10000);
  const path = 'D:/data/tasks/task-1/requirement.md';
  const out = formatInputDescription({ description: desc, descriptionFile: path });

  assert.ok(out.startsWith('字'.repeat(HEAD_MAX)), '应以头部摘录开头');
  assert.ok(!out.includes('字'.repeat(HEAD_MAX + 1)), '头部之后不得继续内联全文');
  assert.match(out, /省略 4,000 字/, '应写明被省略的字数（千分位）');
  assert.ok(out.includes(path), '应给出完整需求文件路径');
  assert.match(out, /read/, '应提示用 read 工具读取全文');
});

test('formatInputDescription：超阈值但缺 descriptionFile 时降级为仅头部 + 省略提示（不崩溃）', () => {
  const out = formatInputDescription({ description: 'x'.repeat(9000) });
  assert.ok(out.startsWith('x'.repeat(HEAD_MAX)));
  assert.match(out, /省略 3,000 字/);
});

test('formatThousands：千分位', () => {
  assert.equal(formatThousands(0), '0');
  assert.equal(formatThousands(999), '999');
  assert.equal(formatThousands(4000), '4,000');
  assert.equal(formatThousands(1234567), '1,234,567');
});
