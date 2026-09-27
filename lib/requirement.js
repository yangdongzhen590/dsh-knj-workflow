/**
 * 需求描述纯函数（Host 侧）：标题派生 + 大文本注入格式。
 *
 * 设计要点（design/new-task-requirement-input.md §3.1/§3.4）：
 *  - 新建任务表单已移除「标题」输入框，标题由 Host 统一派生，客户端不再提交 title。
 *  - 需求描述可任意长，但${inputDescription}注入有界：超阈值时全文落盘
 *    <taskDir>/requirement.md，prompt 只注入头部摘录 + 文件指针，避免
 *    「每个引用它的节点都带十万字」且不静默丢弃内容。
 *  - 阈值以内逐字保持旧行为（向后兼容）。
 */

/** 内联注入上限：超过则落盘 + 只注入头部摘录 */
export const INLINE_MAX = 8000;
/** 落盘后注入的头部摘录长度 */
export const HEAD_MAX = 6000;
/** 完整需求落盘文件名（位于任务目录 <taskDir>/） */
export const REQUIREMENT_FILE_NAME = 'requirement.md';

/** 不可见字符（BOM / 零宽）：从 docx、md、网页复制来的文本常见 */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

/** 真实字符数（码点）：避免代理对被算成 2 个字符 */
export function countChars(text) {
  return Array.from(typeof text === 'string' ? text : '').length;
}

/**
 * 规整粘贴/导入的需求文本：统一换行、剥离不可见字符、去行尾空白、
 * 折叠 3+ 连续空行为 1 个空行、整体 trim。只动空白与不可见字符，不改语义。
 */
export function normalizeRequirementText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 千分位（用于「省略 N 字」等人读数字） */
export function formatThousands(n) {
  const s = String(Math.trunc(Number(n) || 0));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 派生任务标题（表单已无标题输入框）：
 *  1. 需求描述第一条非空行 → 去前导 markdown 井号 → 截断 50 码点；
 *  2. 描述为空/全空白 → 「未命名任务 MM-DD HH:mm」占位标题。
 * 恒返回非空字符串：任务表与看板都依赖 title 渲染。
 */
export function deriveTaskTitle(description, now = new Date()) {
  const firstLine = normalizeRequirementText(description).split('\n').map((l) => l.trim()).find(Boolean) || '';
  const cleaned = firstLine.replace(/^#+\s*/, '').trim();
  if (cleaned) return Array.from(cleaned).slice(0, 50).join('');
  const pad = (n) => String(n).padStart(2, '0');
  return `未命名任务 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 是否需要把全文落盘（超内联阈值） */
export function needsRequirementFile(description) {
  return countChars(normalizeRequirementText(description)) > INLINE_MAX;
}

/**
 * 生成${inputDescription}注入文本。
 * @param {{description?: string, descriptionFile?: string}} task
 * @returns {string} 空描述 → ''；阈值内 → 全文；超阈值 → 头部摘录 + 省略说明 + 文件指针
 */
export function formatInputDescription(task) {
  const text = normalizeRequirementText(task && task.description);
  if (!text) return '';
  const total = countChars(text);
  if (total <= INLINE_MAX) return text;

  const head = Array.from(text).slice(0, HEAD_MAX).join('');
  const omitted = total - countChars(head);
  const file = typeof task?.descriptionFile === 'string' ? task.descriptionFile : '';
  const tail = file
    ? `[…… 以下省略 ${formatThousands(omitted)} 字。\n完整需求已落盘：${file}\n需要细节时用 read 工具读取该文件；本段即可满足常规节点使用。]`
    : `[…… 以下省略 ${formatThousands(omitted)} 字。\n完整需求未落盘（任务缺少 descriptionFile），如需细节请向用户确认。]`;
  return `${head}\n\n${tail}`;
}
