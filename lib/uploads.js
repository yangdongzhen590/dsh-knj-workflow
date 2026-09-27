/**
 * 文件入参的上传暂存（Host 端，零依赖）
 *
 * 为什么需要暂存：新建任务表单打开时任务还不存在——没有 taskId，也就没有
 * `<cwd>/.knj-inputs/<taskId>/`。所以上传先落到 `<dataRoot>/uploads/<uploadId>/<name>`，
 * 等 `WorkflowBridge.startTask` 启动前再物化到工作区（单点 owner，所有创建路径都覆盖）。
 *
 * 安全（本插件栽过一次 task id 路径穿越，同一类错误不重复）：
 *  - 文件名先 `sanitizeFileName` 成 basename 再拼路径；
 *  - `uploadId` 必须匹配严格格式才允许拼路径（`resolve`/`discard` 的入口统一校验）。
 */
import { mkdir, readdir, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 单文件字节上限（前端镜像同一数值用于前置拒绝） */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
/** 物化目标目录名：`<cwd>/.knj-inputs/<taskId>/<文件名>`（工作区内，节点与侧栏都能正常访问） */
export const WORKSPACE_INPUT_DIR = '.knj-inputs';
/** 暂存过期时间：表单开了没提交的上传最多留这么久 */
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
/** 上传路由的请求体上限：必须容得下 base64 膨胀（4/3）+ JSON 包装的余量 */
export const UPLOAD_BODY_BYTES = Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 1024 * 1024;

const UPLOAD_ID_RE = /^up-[a-z0-9]+-[a-z0-9]{8}$/;
const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f\u007f]/g;
const MAX_NAME_LEN = 120;

/** 类型化错误：路由据此回 400 + code。 */
export class UploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
    this.status = 400;
  }
}

/**
 * 把任意上传名消毒成可安全拼路径的 basename（不可用时返回空串）。
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeFileName(raw) {
  let name = String(raw == null ? '' : raw);
  // basename：两种分隔符都切（浏览器可能给 Windows 路径）
  name = name.split(/[\\/]/).pop() || '';
  name = name.replace(ILLEGAL_CHARS, '');
  name = name.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  if (!name) return '';
  if (/^\.+$/.test(name)) return '';
  if (name.length > MAX_NAME_LEN) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    const keep = MAX_NAME_LEN - ext.length;
    name = name.slice(0, Math.max(1, keep)) + ext;
  }
  return name;
}

/**
 * 上传暂存库。
 * 目录布局：`<root>/<uploadId>/<safeName>`。
 */
export class UploadStore {
  constructor(root) {
    this.root = root;
  }

  dirFor(uploadId) {
    return join(this.root, uploadId);
  }

  /**
   * 暂存一次上传。
   * @param {{name?: string, dataBase64?: string}} payload
   * @param {{maxBytes?: number}} [limits]
   * @returns {Promise<{uploadId: string, name: string, size: number}>}
   */
  async stage(payload = {}, limits = {}) {
    const maxBytes = limits.maxBytes ?? MAX_UPLOAD_BYTES;
    const name = sanitizeFileName(payload.name);
    if (!name) throw new UploadError('invalid-name', `文件名不可用：${String(payload.name ?? '')}`);

    const dataBase64 = payload.dataBase64;
    if (typeof dataBase64 !== 'string' || !/^[A-Za-z0-9+/\s]*={0,2}$/.test(dataBase64)) {
      throw new UploadError('invalid-payload', '文件内容不是合法的 base64');
    }
    const buf = Buffer.from(dataBase64.replace(/\s+/g, ''), 'base64');
    if (buf.length === 0) throw new UploadError('empty-file', '文件内容为空');
    if (buf.length > maxBytes) {
      throw new UploadError('file-too-large', `文件过大（${buf.length} 字节 > ${maxBytes} 字节）`);
    }

    const uploadId = `up-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    await mkdir(this.dirFor(uploadId), { recursive: true });
    await writeFile(join(this.dirFor(uploadId), name), buf);
    // 目录 mtime 决定是否过期，显式刷新一次（写文件不一定更新目录 mtime）
    const now = new Date();
    await utimes(this.dirFor(uploadId), now, now).catch(() => {});
    return { uploadId, name, size: buf.length };
  }

  /**
   * 解析 uploadId → 暂存文件信息（不删除）。
   * @returns {Promise<{uploadId: string, name: string, dir: string, path: string}|null>}
   */
  async resolve(uploadId) {
    if (typeof uploadId !== 'string' || !UPLOAD_ID_RE.test(uploadId)) return null;
    const dir = this.dirFor(uploadId);
    let entries = [];
    try { entries = await readdir(dir); } catch { return null; }
    const name = entries.find((e) => !e.startsWith('.')) || entries[0];
    if (!name) return null;
    const path = join(dir, name);
    try {
      const s = await stat(path);
      if (!s.isFile()) return null;
    } catch { return null; }
    return { uploadId, name, dir, path };
  }

  /** 删除一次暂存（物化成功后的清理，或用户取消）。 */
  async discard(uploadId) {
    if (typeof uploadId !== 'string' || !UPLOAD_ID_RE.test(uploadId)) return false;
    const dir = this.dirFor(uploadId);
    try {
      await stat(dir);
    } catch { return false; }
    await rm(dir, { recursive: true, force: true });
    return true;
  }

  /**
   * 清理过期暂存。只处理 `up-*` 形态的目录，绝不碰别人的东西。
   * @returns {Promise<number>} 清理数量
   */
  async pruneStale(maxAgeMs = STAGING_TTL_MS) {
    let entries = [];
    try { entries = await readdir(this.root); } catch { return 0; }
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const name of entries) {
      if (!UPLOAD_ID_RE.test(name)) continue;
      const dir = join(this.root, name);
      let s;
      try { s = await stat(dir); } catch { continue; }
      if (!s.isDirectory()) continue;
      if (s.mtimeMs >= cutoff) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      } catch { /* 占用中/权限问题：下次再试 */ }
    }
    return removed;
  }
}
