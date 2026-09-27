/**
 * 内置通用附件（Host 端，零依赖）
 *
 * 为什么不做「声明式」：文件入参（lib/uploads.js + graph.inputs[type=file]）要求先在
 * 工作流编辑器里声明参数，实机上用户的 7 个工作流全部零声明 —— 于是「新建任务」里
 * 压根没有选文件的地方，用户第一反应是「文件没有看到在哪里选择」。附件的真实用途是
 * 「把一份/几份参考资料丢给节点，让节点自己解析」（docx / md 从本地直接选），它是通用
 * 能力，不该先回编辑器声明一遍才看得见。所以这里由 Host 兜底：表单永远显示附件区，
 * 不需要任何声明。
 *
 * 契约（与 orchestrator/节点 prompt 的对应关系）：
 *  - 附件统一灌进 `inputs.附件`，值是**换行拼接的绝对路径串**（`\n` 分隔）。
 *    节点 prompt 写 `${inputs.附件}` 即可拿到全部路径；路径必须绝对，因为节点
 *    subagent 的工作目录可能与任务 cwd 不同。
 *  - 与声明式文件入参的差别只在「键名固定」，物化机制完全共用
 *    （暂存 → 启动前落进 `<cwd>/.knj-inputs/<taskId>/` → 清暂存）。
 *
 * 单点 owner 仍是 `WorkflowBridge.startTask`：路由、调度器服务（不走路由）、
 * 命令、resume/rerun 都经过它，所以物化只在这里发生一次。
 *
 * 安全（本插件栽过一次 task id 路径穿越，同一类错误不重复）：
 *  - 文件名一律 `sanitizeFileName` 成 basename 再拼路径；
 *  - 即使 sanitize 被绕过（如 Windows 上 `..\\x` 之类），拼完还要 `assertInsideDir`
 *    兜一次：目标必须真的落在任务输入目录内，否则拒绝启动。
 */
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute, relative, resolve } from 'node:path';
import { sanitizeFileName, WORKSPACE_INPUT_DIR } from './uploads.js';

/** 附件的固定输入键：节点 prompt 用 `${inputs.附件}` 引用 */
export const ATTACHMENTS_INPUT_NAME = '附件';
/** 单次任务附件数量上限（防一次丢进来几百个文件把 prompt 与磁盘压垮） */
export const MAX_ATTACHMENTS = 20;

/**
 * 从请求体里规范化附件引用（只取 uploadId + name，绝不含文件内容）。
 *
 * 形状不合法（不是数组）→ 返回空数组而不是抛错：附件是可选的通用能力，请求体里塞了
 * 垃圾字段时不该让整个建任务失败。但**数组里单个条目缺 uploadId** 会原样保留，
 * 由 normalize 阶段统一拒绝（避免"看起来传了 3 个文件，实际只物化 2 个"的静默丢件）。
 *
 * @param {unknown} raw
 * @returns {Array<{uploadId: string, name?: string}>}
 */
export function normalizeAttachmentRefs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
    .map((x) => ({
      uploadId: typeof x.uploadId === 'string' ? x.uploadId : '',
      ...(typeof x.name === 'string' && x.name ? { name: x.name } : {}),
    }));
}

/**
 * 校验附件引用：数量上限 + 每条必须有 uploadId。
 * @param {Array<{uploadId: string, name?: string}>} refs
 * @returns {string|null} 错误信息（null = 通过）
 */
export function describeAttachmentsError(refs) {
  if (refs.length > MAX_ATTACHMENTS) {
    return `附件最多 ${MAX_ATTACHMENTS} 个（收到 ${refs.length} 个）`;
  }
  const bad = refs.findIndex((x) => !x.uploadId);
  if (bad >= 0) return `附件第 ${bad + 1} 个缺少 uploadId（请重新选择文件后再提交）`;
  return null;
}

/** 目标路径必须真在 `dir` 内（防 sanitize 被绕过后的路径穿越）。
 *  导出供测试直接打靶：上游名字都要先过 `sanitizeFileName`，经由 public 入口喂不进
 *  越界名，只能直接验证这一层——否则这道护栏就是没人验证过的死代码。 */
export function assertInsideDir(dir, dest) {
  const rel = relative(resolve(dir), resolve(dest));
  // rel 为空 → dest 就是 dir 本身；以 .. 开头 / 是绝对路径 / 带盘符 → 都在 dir 之外
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`附件目标路径越界：${dest}`);
  }
}

/**
 * 把已暂存的附件物化进 `<cwd>/.knj-inputs/<taskId>/`，并把换行拼接的绝对路径写进
 * `task.inputs.附件`。
 *
 * 触发条件：`task.pendingAttachments` 非空。幂等：物化成功后清掉 pending，重复调用直接返回
 * （resume/rerun 会再次经过 startTask）。
 *
 * 失败语义（关键）：附件是「用户明确要交给节点的东西」，少一个文件就可能让节点基于不完整
 * 材料干活——所以任一条暂存失效都**拒绝启动**并报出文件名，而不是跳过。失败时回滚本次
 * 已写入的文件，避免重试时残留半套材料、同名文件被误判为冲突。
 *
 * @param {import('./uploads.js').UploadStore|undefined} uploads
 * @param {{id: string, cwd?: string, inputs?: Record<string, unknown>, pendingAttachments?: unknown}} task
 */
export async function materializeAttachments(uploads, task) {
  const refs = normalizeAttachmentRefs(task?.pendingAttachments);
  if (refs.length === 0) {
    // 没有附件时**绝不**创建 inputs.附件 键：否则节点把空串当路径用（会真的去读 ""）
    if (task && 'pendingAttachments' in task) delete task.pendingAttachments;
    return;
  }
  if (!uploads) throw new Error('附件需要上传服务，但当前上下文没有 uploads（请重启 dsh web 后重试）');
  if (!task.cwd) throw new Error('附件需要任务工作目录（cwd），当前为空：请在新建任务时选择工作目录');

  const dir = join(task.cwd, WORKSPACE_INPUT_DIR, task.id);
  await mkdir(dir, { recursive: true });
  // 与声明式文件入参同一个忽略文件：附件是任务输入产物，不该被提交
  const gitignore = join(task.cwd, WORKSPACE_INPUT_DIR, '.gitignore');
  if (!existsSync(gitignore)) {
    await writeFile(gitignore, '*\n', 'utf8').catch(() => {});
  }

  const written = [];
  const paths = [];
  const reusable = task.attachmentsAreReusable === true;
  // 上次运行物化过的名字（本任务自己的产物）。用它区分两种"目标已存在"：
  //   - 上次运行留下的同名文件 → 是同一个附件，本次**覆盖**（否则反复触发会堆出 2-x、3-x…）
  //   - 其他来源的同名文件（本次用户另选的一份）→ 加序号，**绝不覆盖**别人的东西
  const marker = join(dir, '.knj-materialized-names.json');
  const previousNames = new Set(readMaterializedNames(marker));
  const seenThisRun = new Set();
  try {
    for (const ref of refs) {
      const staged = await uploads.resolve(ref.uploadId);
      if (!staged) {
        const label = sanitizeFileName(ref.name) || ref.name || ref.uploadId;
        throw new Error(`附件 ${label} 的上传已失效（暂存被清理或未上传成功）：请重新选择文件后再启动`);
      }
      const safeName = sanitizeFileName(staged.name);
      if (!safeName) throw new Error(`附件文件名不可用：${String(staged.name ?? '')}`);

      let dest = join(dir, safeName);
      assertInsideDir(dir, dest);
      const isOwnPrevious = previousNames.has(safeName) && !seenThisRun.has(safeName);
      if (existsSync(dest) && !isOwnPrevious) {
        // 同名冲突（用户这次另选了一份同名文件）：加序号前缀，**绝不覆盖**先前的材料
        let index = 2;
        let candidate = join(dir, `${index}-${safeName}`);
        while (existsSync(candidate)) {
          index += 1;
          candidate = join(dir, `${index}-${safeName}`);
          assertInsideDir(dir, candidate);
        }
        dest = candidate;
      }
      // copy + 清理暂存，而不是 rename：暂存在 ~/.dsh（常在 C:），工作区可能在别的盘，
      // 跨盘 rename 在 Windows 上会 EXDEV 失败。
      await copyFile(staged.path, dest);
      // 校验真的落到位（copyFile 成功但目标不可读的异常场景下宁可报错）
      const info = await stat(dest).catch(() => null);
      if (!info || !info.isFile()) throw new Error(`附件 ${safeName} 写入失败：${dest}`);
      written.push(dest);
      seenThisRun.add(safeName);
      paths.push(dest);
      // reusable（调度器附件）：暂存由调用方每次触发重新准备，这里**不能**丢弃，
      // 否则第二次触发就报"暂存已失效"。一次性交接（表单）保持默认丢弃语义。
      if (!reusable) await uploads.discard(staged.uploadId);
    }
  } catch (error) {
    // 回滚本次已写入的文件：不留半套材料
    for (const p of written) await rm(p, { force: true }).catch(() => {});
    throw error;
  }

  // 记下"本任务物化过哪些名字"，供下次运行区分"自己的旧文件"与"用户新选的同名文件"
  await writeFile(marker, JSON.stringify([...new Set([...previousNames, ...seenThisRun])]), 'utf8').catch(() => {});

  const inputs = { ...(task.inputs && typeof task.inputs === 'object' ? task.inputs : {}) };
  inputs[ATTACHMENTS_INPUT_NAME] = paths.join('\n');
  task.inputs = inputs;
  // reusable 时保留 pendingAttachments：下一次触发还要用它（配合每次重新 stageAttachments）
  if (!reusable) delete task.pendingAttachments;
}

/** 读取"本任务物化过的文件名"标记；缺失或损坏时返回空数组（不因此中断启动）。 */
function readMaterializedNames(markerPath) {
  try {
    const raw = readFileSync(markerPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
