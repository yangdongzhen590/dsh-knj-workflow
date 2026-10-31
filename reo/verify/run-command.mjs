/**
 * 用「已安装的 219 代码」在只读模式下跑 /dev-task，输出与 GUI 命令完全一致的文本。
 * 不调用 store.init()（会写盘），只做 listWorkflows/listTasks/getTask 这些只读调用。
 * 运行：node reo/verify/run-command.mjs wf
 *       node reo/verify/run-command.mjs list
 *       node reo/verify/run-command.mjs status task-xxx
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const INSTALLED = join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-knj-workflow');
const DATA_ROOT = join(homedir(), '.dsh', 'dev-orchestrator');
const host = await import(pathToFileURL(join(INSTALLED, 'lib', 'index.js')).href);

const commands = {
  registered: null,
  register(def) { this.registered = def; return () => {}; },
};
const ctx = {
  get: (name) => (name === 'commands' ? commands : undefined),
  effect: (fn) => { const d = fn(); return () => d?.(); },
  logger: { info() {}, warn() {} },
};
const store = new host.DevTaskStore(DATA_ROOT);
const bridge = { startTask: async () => { throw new Error('只读模式不启动任务'); } };
host.registerCommands(ctx, store, bridge);

const raw = process.argv.slice(2).join(' ');
const result = await commands.registered.handler({ rawInput: ` ${raw}`, agent: null, attachments: [], signal: undefined });
console.log(`[kind=${result.kind}]`);
console.log(result.text);
