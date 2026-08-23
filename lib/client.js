window.__ModuleLoader__.load({
	id: "dsh-knj-workflow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let react_dom_client = require("react-dom/client");

		// ---------------------------------------------------------------------------
		// dsh-knj-workflow Client 端
		// 任务列表 / 任务详情（横向步骤条 + 阶段重跑/继续）/ 工作流配置
		// 数据通过同源 fetch('/devtask/...') 与 Host HTTP API 通信
		// ---------------------------------------------------------------------------
		const PREFIX = '/devtask';

		// sessions 服务（apply 时注入）：用于「执行记录」把节点 subagent 跳回原生会话查看
		let _sessions = null;
		// workspaces 服务（apply 时注入）：用于「新建任务」工作目录下拉
		let _workspaces = null;
		let _ctx = null; // client root ctx（动态取服务，避免 apply 时机问题）

		async function api(path, opts = {}) {
			const res = await fetch(`${PREFIX}${path}`, {
				credentials: 'same-origin',
				...opts,
				headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
				...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
			return data;
		}

		const STATUS_META = {
			pending: { label: '待执行', color: 'var(--dsw-static-neutral-bluish-400)' },
			running: { label: '运行中', color: 'var(--dsw-static-blue-600)' },
			success: { label: '成功', color: 'var(--dsw-static-green-500)' },
			failed: { label: '失败', color: 'var(--dsw-static-red-500)' },			cancelled: { label: '已取消', color: 'var(--dsw-static-amber-500)' },
			'waiting-human': { label: '待人工处理', color: '#7c5cff' },
		};
		/** 人工节点去向：routes 优先（多去向），兼容旧 approveTo/rejectTo（推导为 通过/驳回 两条） */
		function humanRoutes(node) {
			if (Array.isArray(node.routes) && node.routes.length > 0) return node.routes;
			const r = [];
			if (node.approveTo) r.push({ label: '通过', to: node.approveTo, tone: 'success' });
			if (node.rejectTo) r.push({ label: '驳回', to: node.rejectTo, tone: 'danger' });
			return r;
		}
		const ROUTE_TONES = { success: '#16a34a', danger: '#dc2626', warning: '#d97706', info: '#2f6bff', neutral: '#5b6472' };
		function routeColor(route) { return ROUTE_TONES[route.tone] || ROUTE_TONES.info; }
		/** 人工去向是否有缺失（无去向或某去向目标为空）→ 画布警示 */
		function humanRoutesIncomplete(node) {
			const routes = humanRoutes(node);
			if (routes.length === 0) return true;
			return routes.some((r) => !r.to);
		}
		/** 16×16 outline SVG 图标（lucide 风格，与 DSH 原生图标同规格） */
		function icon(kind) {
			if (kind === 'check') return react.createElement('svg', { viewBox: '0 0 16 16', fill: 'none' }, react.createElement('path', { d: 'M3.5 8.5l3 3 6-6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
			if (kind === 'clock') return react.createElement('svg', { viewBox: '0 0 16 16', fill: 'none' }, react.createElement('circle', { cx: '8', cy: '8', r: '5.5', stroke: 'currentColor', strokeWidth: 1.5 }), react.createElement('path', { d: 'M8 5v3l2 1.2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }));
			if (kind === 'plus') return react.createElement('svg', { viewBox: '0 0 16 16', fill: 'none' }, react.createElement('path', { d: 'M8 3.5v9M3.5 8h9', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }));
			if (kind === 'x') return react.createElement('svg', { viewBox: '0 0 16 16', fill: 'none' }, react.createElement('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }));
			if (kind === 'gear') return react.createElement('svg', { viewBox: '0 0 16 16', fill: 'none' }, react.createElement('circle', { cx: '8', cy: '8', r: '2.2', stroke: 'currentColor', strokeWidth: 1.5 }), react.createElement('path', { d: 'M8 1.5v2.3M8 12.2v2.3M1.5 8h2.3M12.2 8h2.3M3.4 3.4l1.6 1.6M11 11l1.6 1.6M12.6 3.4L11 5M5 11l-1.6 1.6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }));
			if (kind === 'list') return react.createElement('svg', { viewBox: '0 0 16 16', fill: 'none' }, react.createElement('rect', { x: '2.5', y: '2.5', width: '11', height: '11', rx: '2', stroke: 'currentColor', strokeWidth: 1.5 }), react.createElement('path', { d: 'M6 6h.01M6 8.5h.01M6 11h.01M10 6h.01M10 8.5h.01M10 11h.01', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }));
			if (kind === 'repeat') return react.createElement('svg', { viewBox: '0 0 16 16', fill: 'none' }, react.createElement('path', { d: 'M13 8a5 5 0 1 1-1.5-3.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }), react.createElement('path', { d: 'M13 1.5V5h-3.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
			if (kind === 'play') return react.createElement('svg', { viewBox: '0 0 16 16', fill: 'currentColor' }, react.createElement('path', { d: 'M5 3.5l7 4.5-7 4.5z' }));
			if (kind === 'refresh') return react.createElement('svg', { viewBox: '0 0 16 16', fill: 'none' }, react.createElement('path', { d: 'M13 8a5 5 0 1 1-1.5-3.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }), react.createElement('path', { d: 'M13 1.5V5h-3.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
			if (kind === 'chevron-down') return react.createElement('svg', { viewBox: '0 0 16 16', fill: 'none' }, react.createElement('path', { d: 'M4 6l4 4 4-4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
			if (kind === 'chevron-right') return react.createElement('svg', { viewBox: '0 0 16 16', fill: 'none' }, react.createElement('path', { d: 'M6 4l4 4-4 4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }));
			return null;
		}
		const STAGE_META = {
			pending: { label: '待执行', color: 'var(--dsw-static-neutral-bluish-300)' },
			running: { label: '运行中', color: 'var(--dsw-static-blue-600)' },
			done: { label: '完成', color: 'var(--dsw-static-green-500)' },
			failed: { label: '失败', color: 'var(--dsw-static-red-500)' },
			skipped: { label: '跳过', color: 'var(--dsw-static-neutral-bluish-400)' },
		};

		const css = `
/* dsh-knj-workflow 样式：跟随 DSH 原生设计令牌（--dsw-*）与字号阶梯
   原生字号体系：标题 16/500 · 正文 14/400(lh22) · 辅助 12/400(lh18)
   原生按钮：36px 高胶囊 · 输入：10px 圆角 + border-l2 + bg-layer-1 */
.knj-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-2);z-index:9999;display:flex;align-items:center;justify-content:center}
.knj-panel{background:var(--dsw-specific-menu);border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;width:min(960px,94vw);max-height:88vh;display:flex;flex-direction:column;box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}
.knj-head{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.knj-head h2{margin:0;font-size:16px;font-weight:500;color:var(--dsw-alias-label-primary)}
.knj-close{margin-left:auto;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;height:32px;padding:0 14px;cursor:pointer;font-size:14px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center}
.knj-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.knj-body{padding:20px;overflow:auto;flex:1}
.knj-tabs{display:flex;gap:6px;margin-bottom:16px}
.knj-tab{border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:999px;height:32px;padding:0 14px;font-size:14px;cursor:pointer;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center}
.knj-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.knj-tab.on{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.knj-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:12px 14px;margin-bottom:10px;display:flex;align-items:center;gap:12px}
.knj-card .title{font-weight:500;font-size:14px;color:var(--dsw-alias-label-primary)}
.knj-card .sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.knj-badge{font-size:12px;padding:2px 10px;border-radius:999px;color:#fff;font-weight:500;line-height:18px;white-space:nowrap}
.knj-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:999px;height:32px;padding:0 14px;font-size:14px;cursor:pointer;color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:background .15s,color .15s}
.knj-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.knj-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.knj-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}
.knj-btn.danger{color:var(--dsw-alias-state-error-primary)}
.knj-btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.knj-btn:disabled{opacity:.5;cursor:not-allowed}
.knj-btn svg{flex:none;width:16px;height:16px}
.knj-progress{height:4px;background:var(--dsw-alias-border-l2);border-radius:999px;overflow:hidden;width:140px}
.knj-progress>div{height:100%;background:var(--dsw-alias-state-business-primary);transition:width .4s}
.knj-steps{display:flex;align-items:flex-start;gap:0;padding:10px 4px;overflow-x:auto}
.knj-step{display:flex;flex-direction:column;align-items:center;flex:0 0 auto;width:110px;position:relative}
.knj-step .dot{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;z-index:1}
.knj-step .dot svg{width:14px;height:14px}
.knj-step .lbl{font-size:12px;line-height:18px;margin-top:6px;text-align:center;color:var(--dsw-alias-label-secondary);max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knj-step .act{margin-top:6px;min-height:26px}
.knj-step .link{position:absolute;top:14px;left:55px;width:110px;height:2px;background:var(--dsw-alias-border-l2)}
.knj-step .link.done{background:var(--dsw-alias-state-success-primary)}
.knj-step:last-child .link{display:none}
.knj-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:10px;height:36px;padding:0 12px;font-size:14px;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary)}
.knj-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.knj-input:focus{outline:2px solid var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.knj-input:disabled{opacity:.5}
.knj-row{display:flex;gap:10px;margin-bottom:12px;align-items:center}
.knj-empty{color:var(--dsw-alias-label-tertiary);text-align:center;padding:30px;font-size:14px}
.knj-err{background:var(--dsw-alias-state-error-secondary);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:12px;line-height:18px}
.knj-textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:8px 12px;font-size:14px;width:100%;box-sizing:border-box;font-family:var(--dsw-font-family);min-height:120px;resize:both;overflow:auto;color:var(--dsw-alias-label-primary);line-height:22px}
.knj-textarea:focus{outline:2px solid var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.knj-textarea.knj-invalid{border-color:var(--dsw-alias-state-error-primary);outline:1px solid var(--dsw-alias-state-error-primary)}
.knj-stage-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:8px 12px;margin-bottom:8px}
.knj-stage-row input{flex:1}
.knj-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-label-primary-inverted);padding:10px 18px;border-radius:999px;font-size:14px;z-index:10001;box-shadow:var(--dsw-shadow-lv2)}
.knj-prompt-block{margin-bottom:10px}
.knj-prompt-block .lbl2{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}
/* 左侧栏入口按钮：与原生「设置」触发按钮逐属性对齐（.VOzbGW_trigger） */
.knj-newtask{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-radius:12px;flex:none;justify-content:flex-start;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden;transition:background .15s}
.knj-newtask:hover{background:var(--dsw-alias-interactive-bg-hover)}
.knj-newtask:active{background:var(--dsw-alias-interactive-bg-active)}
.knj-newtask svg,.knj-newtask .knj-ico{flex:none;width:16px;height:16px;color:var(--dsw-alias-label-primary)}
.knj-form-section{margin-bottom:12px}
.knj-form-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}
/* 中央「开发任务」页签：铺满主区 */
.knj-workbench{height:100%;display:flex;flex-direction:column;padding:16px 20px;overflow:auto;box-sizing:border-box;color:var(--dsw-alias-label-primary)}
/* 工作台顶部：下划线 tab + 新建按钮 */
.knj-wb-head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--dsw-alias-border-l2);margin-bottom:16px;flex:none}
.knj-wb-tabs{display:flex;gap:4px}
.knj-wb-tab{background:transparent;border:none;padding:10px 14px;font-size:14px;cursor:pointer;color:var(--dsw-alias-label-secondary);border-bottom:2px solid transparent;margin-bottom:-1px;font-family:inherit;transition:color .15s}
.knj-wb-tab:hover{color:var(--dsw-alias-label-primary)}
.knj-wb-tab.on{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-state-business-primary)}
/* 任务/工作流卡片 */
.knj-item-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:14px 16px;margin-bottom:10px;transition:border-color .15s,box-shadow .15s}
.knj-item-card:hover{border-color:var(--dsw-alias-border-l3);box-shadow:0 2px 8px rgba(16,24,40,.06)}
.knj-item-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.knj-item-title{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knj-item-title:hover{color:var(--dsw-alias-state-business-primary)}
.knj-item-stage{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-top:6px}
.knj-item-foot{display:flex;align-items:center;gap:10px;margin-top:10px}
.knj-item-foot .knj-progress{flex:1;width:auto}
.knj-item-pct{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:36px;text-align:right;font-variant-numeric:tabular-nums}
/* 分页器 */
.knj-pager{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:14px}
.knj-pager button{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;width:32px;height:32px;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:16px}
.knj-pager button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.knj-pager button:disabled{opacity:.4;cursor:not-allowed}
.knj-pager .pg{font-size:12px;color:var(--dsw-alias-label-secondary)}
.knj-workbench .knj-tabs{margin-bottom:14px}
/* 图编辑器（GraphEditor）：三段式画布 */
.knj-graph-editor{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.knj-graph-editor.knj-fullscreen{position:fixed;inset:0;z-index:1000;background:var(--dsw-alias-bg-base)}
.knj-ge-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.knj-ge-body{flex:1;display:grid;grid-template-columns:160px 1fr 600px;min-height:0}
.knj-ge-palette{padding:12px;border-right:1px solid var(--dsw-alias-border-l2);overflow:auto;display:flex;flex-direction:column}
.knj-ge-canvas{position:relative;overflow:auto;background:linear-gradient(var(--dsw-alias-border-l2) 1px,transparent 1px),linear-gradient(90deg,var(--dsw-alias-border-l2) 1px,transparent 1px);background-size:20px 20px;background-color:var(--dsw-alias-bg-base)}
.knj-ge-props{border-left:1px solid var(--dsw-alias-border-l2);overflow:auto;padding:12px}
.knj-ge-resizer{width:5px;cursor:col-resize;background:var(--dsw-alias-border-l2);flex:none;transition:background .15s}
.knj-ge-resizer:hover{background:var(--dsw-alias-state-business-primary)}
.knj-ge-props-inner{display:flex;flex-direction:column;gap:8px}
.knj-ge-svg{display:block}
/* 任务详情：流程节点卡片（纵向，整合状态/产物/执行记录） */
.knj-node-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:10px;margin-bottom:8px;overflow:hidden;transition:border-color .15s}
.knj-node-card:hover{border-color:var(--dsw-alias-border-l3)}
.knj-node-head{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer}
.knj-node-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.knj-node-dot{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;flex:none;font-size:11px}
.knj-node-dot svg{width:12px;height:12px}
.knj-node-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);line-height:18px}
.knj-node-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:16px}
.knj-node-body{border-top:1px solid var(--dsw-alias-border-l2);padding:10px 12px;background:var(--dsw-alias-bg-base)}
.knj-node-sec{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary);margin:8px 0 4px}
.knj-node-sec:first-child{margin-top:0}
.knj-node-body pre{font-size:12px;line-height:1.5;overflow:auto;max-height:200px;margin:0;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px}
`;

		function toast(msg) {
			const el = document.createElement('div');
			el.className = 'knj-toast';
			el.textContent = msg;
			document.body.appendChild(el);
			setTimeout(() => el.remove(), 2000);
		}

		let overlayRoot = null;
		let overlayStyle = null;
		function ensureStyle() {
			if (!overlayStyle) {
				overlayStyle = document.createElement('style');
				overlayStyle.textContent = css;
				document.head.appendChild(overlayStyle);
			}
		}
		function openOverlay(tab) {
			if (overlayRoot) {
				overlayRoot.style.display = 'flex';
				return;
			}
			ensureStyle();
			overlayRoot = document.createElement('div');
			document.body.appendChild(overlayRoot);
			react_dom_client.createRoot(overlayRoot).render(react.createElement(Overlay, { initialTab: tab || 'tasks' }));
		}

		class Overlay extends react.Component {
			constructor(props) {
				super(props);
				this.state = { tab: props.initialTab || 'tasks', tasks: [], workflows: [], error: null, loading: true };
			}
			componentDidMount() { this.refresh(); this._timer = setInterval(() => this.refresh(), 3000); }
			componentWillUnmount() { clearInterval(this._timer); }
			async refresh() {
				try {
					const [t, w] = await Promise.all([api('/tasks'), api('/workflows')]);
					this.setState({ tasks: t.tasks || [], workflows: w.workflows || [], error: null, loading: false });
				} catch (e) {
					this.setState({ error: e.message, loading: false });
				}
			}
			render() {
				const { tab, tasks, workflows, error } = this.state;
				return react.createElement('div', { className: 'knj-overlay' },
					react.createElement('div', { className: 'knj-panel' },
						react.createElement('div', { className: 'knj-head' },
							react.createElement('h2', null, '开发任务编排'),
							react.createElement('div', { className: 'knj-tabs', style: { margin: 0, marginLeft: 16 } },
								react.createElement('button', { className: 'knj-tab' + (tab === 'tasks' ? ' on' : ''), onClick: () => this.setState({ tab: 'tasks' }) }, '任务'),
								react.createElement('button', { className: 'knj-tab' + (tab === 'workflows' ? ' on' : ''), onClick: () => this.setState({ tab: 'workflows' }) }, '工作流'),
							),
							react.createElement('button', { className: 'knj-close', onClick: () => { if (overlayRoot) overlayRoot.style.display = 'none'; } }, '关闭'),
						),
						react.createElement('div', { className: 'knj-body' },
							error ? react.createElement('div', { className: 'knj-err' }, '加载失败：' + error) : null,
							tab === 'tasks'
								? react.createElement(TasksView, { tasks, workflows, onChanged: () => this.refresh() })
								: react.createElement(WorkflowsView, { workflows, onChanged: () => this.refresh() }),
						),
					),
				);
			}
		}

		class TasksView extends react.Component {
			constructor(props) {
				super(props);
				this.state = { newTitle: '', newWf: '', showNew: false, detail: null, busy: false };
			}
			render() {
				const { tasks, workflows } = this.props;
				const { detail } = this.state;
				if (detail) {
					return react.createElement(TaskDetail, {
						task: detail,
						onBack: () => this.setState({ detail: null }),
						onChanged: async () => { await this.props.onChanged(); this.loadDetail(detail.id); },
					});
				}
				return react.createElement('div', null,
					react.createElement('div', { className: 'knj-row' },
						react.createElement('button', { className: 'knj-btn primary', onClick: () => this.setState({ showNew: !this.state.showNew }) }, icon('plus'), '新建任务'),
					),
					this.state.showNew ? react.createElement('div', { className: 'knj-card', style: { flexDirection: 'column', alignItems: 'stretch' } },
						react.createElement('div', { className: 'knj-row' },
							react.createElement('input', { className: 'knj-input', placeholder: '任务标题（如：新增文件下载功能）', value: this.state.newTitle, onChange: (e) => this.setState({ newTitle: e.target.value }) }),
						),
						react.createElement('div', { className: 'knj-row' },
							react.createElement('select', { className: 'knj-input', value: this.state.newWf, onChange: (e) => this.setState({ newWf: e.target.value }) },
								react.createElement('option', { value: '' }, '选择工作流…'),
								(workflows || []).map((w) => react.createElement('option', { key: w.id, value: w.id }, `${w.name}（${(w.nodes || []).filter((n) => n.type === 'task').length} 阶段）`)),
							),
							react.createElement('button', {
								className: 'knj-btn primary',
								disabled: this.state.busy || !this.state.newTitle,
								onClick: async () => {
									this.setState({ busy: true });
									try {
										await api('/tasks', { method: 'POST', body: { title: this.state.newTitle, workflowId: this.state.newWf || undefined } });
										toast('任务已创建并启动');
										this.setState({ newTitle: '', newWf: '', showNew: false });
										this.props.onChanged();
									} catch (e) { toast('创建失败：' + e.message); }
									this.setState({ busy: false });
								},
							}, '创建并启动'),
						),
					) : null,
					tasks.length === 0
						? react.createElement('div', { className: 'knj-empty' }, '暂无任务，点击「新建任务」开始')
						: tasks.map((t) => react.createElement('div', { key: t.id, className: 'knj-card' },
							react.createElement('div', { style: { flex: 1, cursor: 'pointer' }, onClick: () => this.loadDetail(t.id) },
								react.createElement('div', { className: 'title' }, t.title),
								react.createElement('div', { className: 'sub' }, `${t.id} · 工作流 ${t.workflowId}${t.currentStage ? ' · 阶段: ' + t.currentStage : ''}`),
							),
							react.createElement('div', { className: 'knj-progress' }, react.createElement('div', { style: { width: progressPct(t) + '%' } })),
							react.createElement('span', { className: 'knj-badge', style: { background: (STATUS_META[t.status] || STATUS_META.pending).color } }, (STATUS_META[t.status] || STATUS_META.pending).label),
							(t.status === 'failed' || t.status === 'cancelled')
								? react.createElement('button', { className: 'knj-btn', onClick: async () => { try { await api('/tasks/' + t.id + '/resume', { method: 'POST', body: {} }); toast('已继续'); this.props.onChanged(); } catch (e) { toast(e.message); } } }, '继续')
								: null,
						)),
				);
			}
			async loadDetail(id) {
				try { const { task } = await api('/tasks/' + id); this.setState({ detail: task }); }
				catch (e) { toast(e.message); }
			}
		}

		class TaskDetail extends react.Component {
			render() {
				const { task, onBack } = this.props;
				const steps = task.stageStates || [];
				const pct = progressPct(task);
				return react.createElement('div', null,
					react.createElement('div', { className: 'knj-row' },
						react.createElement('button', { className: 'knj-btn', onClick: onBack }, '← 返回'),
						react.createElement('div', { style: { flex: 1 } },
							react.createElement('div', { className: 'title', style: { fontSize: 15, fontWeight: 600 } }, task.title),
							react.createElement('div', { className: 'sub' }, `${task.id} · 工作流 ${task.workflowId} · 进度 ${pct}%`),
						),
						react.createElement('span', { className: 'knj-badge', style: { background: (STATUS_META[task.status] || STATUS_META.pending).color } }, (STATUS_META[task.status] || STATUS_META.pending).label),
					),
					react.createElement('div', { className: 'knj-steps' },
						steps.map((s, i) => {
							const meta = STAGE_META[s.status] || STAGE_META.pending;
							const isRunning = s.status === 'running';
							return react.createElement('div', { key: s.id, className: 'knj-step' },
								react.createElement('div', { className: 'link' + (s.status === 'done' ? ' done' : '') }),
								react.createElement('div', { className: 'dot', style: { background: meta.color, ...(isRunning ? { boxShadow: '0 0 0 4px rgba(37,99,235,.2)' } : {}) } },
									s.status === 'done' ? icon('check') : isRunning ? icon('clock') : s.status === 'skipped' ? '–' : (i + 1),
								),
								react.createElement('div', { className: 'lbl' }, s.title),
								react.createElement('div', { className: 'act' },
									s.status === 'failed'
										? react.createElement('button', { className: 'knj-btn danger', onClick: () => this.rerunStage(s.id) }, '重跑')
										: null,
								),
							);
						}),
					),
					(task.status === 'failed' || task.status === 'cancelled')
						? react.createElement('div', { className: 'knj-row' },
							react.createElement('button', { className: 'knj-btn primary', onClick: () => this.resume() }, icon('play'), '继续'),
						)
						: null,
					task.error ? react.createElement('div', { className: 'knj-err' }, '错误：' + task.error) : null,
				);
			}
			async rerunStage(stageId) {
				try {
					await api('/tasks/' + this.props.task.id + '/rerun-stage', { method: 'POST', body: { stageId } });
					toast('已重跑阶段：' + stageId);
					setTimeout(() => this.props.onChanged(), 500);
				} catch (e) { toast(e.message); }
			}
			async resume() {
				try {
					await api('/tasks/' + this.props.task.id + '/resume', { method: 'POST', body: {} });
					toast('任务继续运行');
					setTimeout(() => this.props.onChanged(), 500);
				} catch (e) { toast(e.message); }
			}
		}

		class WorkflowsView extends react.Component {
			constructor(props) {
				super(props);
				this.state = { editing: null };
			}
			render() {
				const { workflows } = this.props;
				const { editing } = this.state;
				if (editing) return react.createElement(GraphEditor, { workflow: editing, onBack: () => this.setState({ editing: null }), onSaved: async () => { this.props.onChanged(); this.setState({ editing: null }); } });
				return react.createElement('div', null,
					react.createElement('div', { className: 'knj-row' },
						react.createElement('button', { className: 'knj-btn primary', onClick: () => {
							this.setState({ editing: { id: 'wf-' + Date.now().toString(36), name: '', description: '', schemaVersion: 2, inputs: [], nodes: [{ id: 'start', type: 'start' }, { id: 'end', type: 'end' }], edges: [] } });
						} }, icon('plus'), '新建工作流'),
					),
					(workflows || []).length === 0
						? react.createElement('div', { className: 'knj-empty' }, '暂无工作流')
						: (workflows || []).map((w) => react.createElement('div', { key: w.id, className: 'knj-card' },
							react.createElement('div', { style: { flex: 1 } },
								react.createElement('div', { className: 'title' }, w.name),
								react.createElement('div', { className: 'sub' }, `${w.id} · ${(w.nodes || []).filter((n) => n.type === 'task').length} 个阶段 · ${w.description || ''}`),
							),
							react.createElement('button', { className: 'knj-btn', onClick: () => this.setState({ editing: w }) }, '编辑'),
							react.createElement('button', { className: 'knj-btn danger', onClick: async () => { try { await api('/workflows/' + w.id, { method: 'DELETE' }); this.props.onChanged(); } catch (e) { toast(e.message); } } }, '删除'),
						)),
				);
			}
		}

		/** 沿边 from 是否可达 to（有向路径存在） */
		function hasPath(edges, from, to) {
			const seen = new Set();
			const dfs = (id) => {
				if (id === to) return true;
				if (seen.has(id)) return false;
				seen.add(id);
				return edges.some((e) => e.from === id && dfs(e.to));
			};
			return dfs(from);
		}

		/** 分层自动布局：拓扑排序（忽略环边）→ 按深度分层 → 每层垂直排列。返回 { nodeId: {x,y} } */
		function autoLayout(nodes, edges) {
			const byId = new Map(nodes.map((n) => [n.id, n]));
			const adj = new Map();
			const inDeg = new Map();
			nodes.forEach((n) => { adj.set(n.id, []); inDeg.set(n.id, 0); });
			edges.forEach((e) => {
				if (hasPath(edges, e.to, e.from)) return; // 环边：to 可达 from，跳过（不参与分层）
				if (!adj.has(e.from) || !adj.has(e.to)) return;
				adj.get(e.from).push(e.to);
				inDeg.set(e.to, inDeg.get(e.to) + 1);
			});
			const queue = nodes.filter((n) => inDeg.get(n.id) === 0).map((n) => n.id);
			const depth = new Map();
			queue.forEach((id) => depth.set(id, 0));
			while (queue.length) {
				const id = queue.shift();
				for (const to of adj.get(id) || []) {
					const d = (depth.get(id) || 0) + 1;
					if (!depth.has(to) || d > depth.get(to)) depth.set(to, d);
					inDeg.set(to, inDeg.get(to) - 1);
					if (inDeg.get(to) === 0) queue.push(to);
				}
			}
			const maxD = Math.max(0, ...depth.values());
			nodes.forEach((n) => { if (!depth.has(n.id)) depth.set(n.id, maxD); });
			const layers = new Map();
			depth.forEach((d, id) => { if (!layers.has(d)) layers.set(d, []); layers.get(d).push(id); });
			const LAYER_W = 200, NODE_H = 96;
			const pos = {};
			[...layers.keys()].sort((a, b) => a - b).forEach((d) => {
				const ids = layers.get(d);
				const totalH = ids.length * NODE_H;
				ids.forEach((id, i) => {
					pos[id] = { x: 120 + d * LAYER_W, y: 80 + i * NODE_H + Math.max(0, (3 - ids.length) * NODE_H / 2) };
				});
			});
			return pos;
		}

		/** 图编辑器：画布 + 节点面板 + 属性面板，自研 SVG */
		class GraphEditor extends react.Component {
			constructor(props) {
				super(props);
				const wf = props.workflow && Array.isArray(props.workflow.nodes)
					? JSON.parse(JSON.stringify(props.workflow))
					: { id: 'wf-' + Date.now().toString(36), name: '', description: '', schemaVersion: 2, inputs: [], nodes: [{ id: 'start', type: 'start' }, { id: 'end', type: 'end' }], edges: [] };
				// 初始布局：已有坐标（保存过的布局）就保留，缺失的用 autoLayout 补，避免首次渲染 SVG 坐标 NaN
				const pos = autoLayout(wf.nodes, wf.edges);
				wf.nodes = wf.nodes.map((n) => ({
					...n,
					x: typeof n.x === 'number' ? n.x : (pos[n.id]?.x ?? 200),
					y: typeof n.y === 'number' ? n.y : (pos[n.id]?.y ?? 200),
				}));
				this.state = { wf, selectedId: null, selectedEdge: null, drag: null, linking: null, hoverId: null, panning: null, zoom: 1, fullscreen: false, propsWidth: 380, resizing: null, schemaError: null, busy: false, error: null, showGuide: false, showNodeGuide: false, tooltip: null, canUndo: false, canRedo: false };
				this.schemaRef = react.createRef();
				// undo/redo：history 存"已提交状态序列"（栈顶 = 最近提交态，undo 恢复它的前一个）；redoStack 存被撤销的状态
				this.history = [JSON.parse(JSON.stringify(wf))];
				this.redoStack = [];
				this._commitTimer = null; // 输入防抖提交计时器
			}
			componentDidMount() {
				document.addEventListener('keydown', this.onKeyDown);
			}
			componentWillUnmount() {
				document.removeEventListener('keydown', this.onKeyDown);
			}
			onKeyDown = (e) => {
				// 焦点在输入控件里时让浏览器走原生编辑撤销，不拦截
				const t = e.target;
				if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
				if ((e.ctrlKey || e.metaKey) && !e.altKey) {
					const k = (e.key || '').toLowerCase();
					if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
					else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); }
				}
			}
			/** 记录一个已提交状态进 history（与栈顶相同则跳过去重）；清空 redo 栈 */
			pushHistory(snap) {
				const prev = this.history[this.history.length - 1];
				if (prev && JSON.stringify(prev) === JSON.stringify(snap)) return;
				this.history.push(snap);
				if (this.history.length > 101) this.history.shift();
				this.redoStack = [];
				this.setState({ canUndo: this.history.length > 1, canRedo: false });
			}
			/** 一次性动作：变更完成后调用，提交变更后的状态（nextWf 为已变更的工作流） */
			pushNow(nextWf) {
				this.flushPending(); // 先提交 pending 输入，保证撤销顺序
				this.pushHistory(JSON.parse(JSON.stringify(nextWf)));
			}
			/** 输入类变更：变更后调用，600ms 无输入后提交（合并连续输入为一个动作） */
			scheduleCommit() {
				clearTimeout(this._commitTimer);
				this._commitTimer = setTimeout(() => {
					this._commitTimer = null;
					this.pushHistory(JSON.parse(JSON.stringify(this.state.wf)));
				}, 600);
			}
			/** 提交待防抖的输入变更（立即入栈，保证顺序） */
			flushPending() {
				if (this._commitTimer) {
					clearTimeout(this._commitTimer);
					this._commitTimer = null;
					this.pushHistory(JSON.parse(JSON.stringify(this.state.wf)));
				}
			}
			undo() {
				this.flushPending();
				if (this.history.length < 2) return; // 栈里至少要有「当前提交态 + 一个历史」
				this.redoStack.push(JSON.parse(JSON.stringify(this.state.wf)));
				this.history.pop();
				this.setState({ wf: this.history[this.history.length - 1], selectedId: null, selectedEdge: null, canUndo: this.history.length > 1, canRedo: true });
			}
			redo() {
				if (!this.redoStack.length) return;
				const cur = JSON.parse(JSON.stringify(this.state.wf));
				const next = this.redoStack.pop();
				this.history.push(cur);
				if (this.history.length > 101) this.history.shift();
				this.setState({ wf: next, selectedId: null, selectedEdge: null, canUndo: true, canRedo: this.redoStack.length > 0 });
			}
			relayout() {
				const wf = this.state.wf;
				const pos = autoLayout(wf.nodes, wf.edges);
				wf.nodes = wf.nodes.map((n) => ({ ...n, x: pos[n.id].x, y: pos[n.id].y }));
				this.pushNow(wf); // 自动布局作为一次可撤销动作
				this.setState({ wf });
			}
			setWf(patch) { this.setState({ wf: { ...this.state.wf, ...patch } }); } // 名称/ID 元数据不进 undo
			patchNode(id, patch, record = true) {
				if (record) this.scheduleCommit();
				const wf = this.state.wf;
				wf.nodes = wf.nodes.map((n) => n.id === id ? { ...n, ...patch } : n);
				this.setState({ wf });
			}
			/** 修改阶段编码（id）：同步更新边与 human 跳转，prompt 引用需手动更新 */
			patchNodeId(oldId, newId) {
				if (!newId || newId === oldId) return;
				if (!/^[a-zA-Z0-9._-]+$/.test(newId) || newId.includes('..')) { toast('阶段编码只能含字母/数字/._-'); return; }
				this.scheduleCommit(); // 逐键输入防抖合并
				const wf = this.state.wf;
				if (wf.nodes.some((n) => n.id === newId && n.id !== oldId)) { toast('阶段编码已存在'); return; }
				// 改 id 后同步所有引用：edges from/to、其他节点的 routes[].to / approveTo / rejectTo / displayFrom / inputs[].from
				const nodes = wf.nodes.map((n) => {
					if (n.id === oldId) return { ...n, id: newId };
					const u = { ...n };
					if (n.approveTo === oldId) u.approveTo = newId;
					if (n.rejectTo === oldId) u.rejectTo = newId;
					if (n.displayFrom === oldId) u.displayFrom = newId;
					if (Array.isArray(n.routes)) u.routes = n.routes.map((r) => (r.to === oldId ? { ...r, to: newId } : r));
					if (Array.isArray(n.inputs)) u.inputs = n.inputs.map((r) => (r.from === oldId ? { ...r, from: newId } : r));
					return u;
				});
				const edges = wf.edges.map((e) => ({ ...e, from: e.from === oldId ? newId : e.from, to: e.to === oldId ? newId : e.to }));
				this.setState({ wf: { ...wf, nodes, edges } });
				toast('阶段编码已更新为 ' + newId + '；prompt 里的 ${' + oldId + '.字段} 引用请手动改为 ${' + newId + '.字段}');
			}
			addNode(type) {
				const wf = this.state.wf;
				const id = type + '-' + Date.now().toString(36);
				const base = { id, type, title: type, x: 200, y: 200 };
				if (type === 'task') {
					Object.assign(base, { inputs: [], body: { prompt: '', mode: 'single', output: {} }, prehook: [], posthook: [] });
				} else if (type === 'human') {
					// 人工节点不预设去向：通常在流程中间（如设计评审），去向由用户按需配置
					Object.assign(base, { displayFrom: '', routes: [] });
				}
				wf.nodes.push(base);
				this.pushNow(wf); // 新增节点后提交，撤销可移除
				this.setState({ wf, selectedId: id });
			}
			removeNode(id) {
				const wf = this.state.wf;
				if (id === 'start' || id === 'end') return;
				wf.nodes = wf.nodes.filter((n) => n.id !== id);
				wf.edges = wf.edges.filter((e) => e.from !== id && e.to !== id);
				this.pushNow(wf); // 删除后提交，撤销可恢复
				this.setState({ wf, selectedId: null });
			}
			buildGraph() {
				const wf = this.state.wf;
				return {
					id: wf.id, name: wf.name, description: wf.description || '',
					schemaVersion: 2, inputs: wf.inputs || [],
					nodes: wf.nodes.map((n) => {
						const out = { ...n, inputs: (n.inputs || []).filter((r) => r.from && r.field) };
						// 人工节点统一输出 routes（旧 approveTo/rejectTo 自动迁移为 通过/驳回 两条去向），并清掉旧字段
						if (n.type === 'human') {
							if (!Array.isArray(n.routes)) {
								const routes = [];
								if (n.approveTo) routes.push({ label: '通过', to: n.approveTo, tone: 'success' });
								if (n.rejectTo) routes.push({ label: '驳回', to: n.rejectTo, tone: 'danger' });
								out.routes = routes;
							}
							delete out.approveTo;
							delete out.rejectTo;
						}
						return out;
					}),
					// 边规范化：value 智能转换（'true'→true、'5'→5；${} 引用保留字符串）、
					// op=in 时 value 转数组、空 when 置 null、同 from→to 去重合并（自愈历史脏数据）
					edges: (() => {
						// UI 值输入框存的是字符串，而 subagent 输出的布尔/数字是真值——
						// 不转换则 'true' === true 永远失配、条件静默走 default。
						const coerce = (v) => {
							if (typeof v !== 'string') return v;
							if (v.startsWith('${')) return v; // 引用字符串（运行时解析），保留
							if (v === 'true') return true;
							if (v === 'false') return false;
							if (v !== '' && !isNaN(Number(v))) return Number(v);
							return v;
						};
						const norm = wf.edges.map((e) => {
							if (e.when && e.when.op === 'in' && typeof e.when.value === 'string') {
								return { ...e, when: { ...e.when, value: e.when.value.split(',').map((s) => s.trim()).filter(Boolean).map(coerce) } };
							}
							if (e.when && typeof e.when.value === 'string') {
								return { ...e, when: { ...e.when, value: coerce(e.when.value) } };
							}
							if (e.when && !e.when.field) return { ...e, when: null };
							return e;
						});
						const out = [];
						const idxByPair = new Map();
						for (const e of norm) {
							const k = e.from + '->' + e.to;
							const i = idxByPair.get(k);
							if (i === undefined) { idxByPair.set(k, out.length); out.push(e); continue; }
							const prev = out[i];
							// 两条都有条件时不自动合并（静默丢条件会悄悄改变路由语义）：
							// 两条都保留，让服务端 validateWorkflow 报「重复边」给用户明确提示。
							if (prev.when && e.when) { out.push(e); continue; }
							// 一条有条件一条没有（如历史脏数据 when 边 + 纯 default 边）→ 合并：when 取有值者，default 任一真则保留
							out[i] = {
								...prev,
								when: prev.when || e.when || null,
								default: !!(prev.default || e.default),
							};
						}
						return out;
					})(),
				};
			}
			async save() {
				const wf = this.state.wf;
				if (!wf.name || !wf.id) { toast('请填写工作流名称和 ID'); return; }
				const graph = this.buildGraph();
				this.setState({ busy: true });
				try {
					await api('/workflows', { method: 'POST', body: graph });
					toast('已保存');
					// 保存成功 = 新基线：规范化结果（去重边/迁移 routes）回写 state，UI 立即干净
					this.flushPending();
					this.setState({ wf: graph });
					this.history = [JSON.parse(JSON.stringify(graph))];
					this.redoStack = [];
					this.setState({ canUndo: false, canRedo: false });
					this.props.onSaved();
				} catch (e) {
					toast('保存失败：' + e.message);
					this.setState({ busy: false });
				}
			}
			// 画布交互：节点拖拽
			startDrag(id, e) {
				const node = this.state.wf.nodes.find((n) => n.id === id);
				const p = this.canvasPoint(e.clientX, e.clientY);
				this.setState({ drag: { id, ox: p.x - node.x, oy: p.y - node.y } });
			}
			// 拖拽连线（从端口拖出）
			startLink(id, e) {
				e.stopPropagation();
				const node = this.state.wf.nodes.find((n) => n.id === id);
				this.setState({ linking: { fromId: id, x: node.x, y: node.y } });
			}
			render() {
				const { onBack } = this.props;
				const { wf, selectedId, drag, linking } = this.state;
				const selected = wf.nodes.find((n) => n.id === selectedId);
				return react.createElement('div', { className: 'knj-graph-editor' + (this.state.fullscreen ? ' knj-fullscreen' : ''), onMouseMove: (e) => this.onCanvasMove(e), onMouseUp: (e) => this.onCanvasUp(e) },
					react.createElement('div', { className: 'knj-ge-head' },
						react.createElement('button', { className: 'knj-btn', onClick: onBack }, '← 返回'),
						react.createElement('input', { className: 'knj-input', style: { flex: 1, maxWidth: 260 }, placeholder: '工作流名称', value: wf.name || '', onChange: (e) => this.setWf({ name: e.target.value }) }),
						react.createElement('input', { className: 'knj-input', style: { maxWidth: 180 }, placeholder: 'ID（唯一）', value: wf.id || '', onChange: (e) => this.setWf({ id: e.target.value }) }),
						react.createElement('button', { className: 'knj-btn', onClick: () => this.home(), title: '回到初始视图' }, '⌂'),
						react.createElement('button', { className: 'knj-btn', onClick: () => this.zoomBy(-0.2), title: '缩小' }, '−'),
						react.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', minWidth: 40, textAlign: 'center' } }, `${Math.round(this.state.zoom * 100)}%`),
						react.createElement('button', { className: 'knj-btn', onClick: () => this.zoomBy(0.2), title: '放大' }, '＋'),
						react.createElement('button', { className: 'knj-btn', onClick: () => this.setState({ fullscreen: !this.state.fullscreen }), title: '全屏' }, this.state.fullscreen ? '退出全屏' : '⛶ 全屏'),
						react.createElement('button', { className: 'knj-btn', onClick: () => this.relayout() }, '自动布局'),
						react.createElement('button', { className: 'knj-btn', disabled: !this.state.canUndo, onClick: () => this.undo(), title: '撤销 (Ctrl+Z)' }, '↶'),
						react.createElement('button', { className: 'knj-btn', disabled: !this.state.canRedo, onClick: () => this.redo(), title: '重做 (Ctrl+Y)' }, '↷'),
						react.createElement('button', { className: 'knj-btn', title: '工作流配置说明（节点 / 网关 / 连线 / 人工审批）', onClick: () => this.setState({ showGuide: true }) }, '❓ 配置说明'),
						react.createElement('button', { className: 'knj-btn primary', disabled: this.state.busy, onClick: () => this.save() }, '保存'),
					),
					react.createElement('div', { className: 'knj-ge-body', style: { gridTemplateColumns: `150px 1fr 5px ${this.state.propsWidth}px` } },
						react.createElement('div', { className: 'knj-ge-palette' },
							react.createElement('div', { className: 'knj-form-label' }, '添加节点'),
							['task', 'gateway-xor', 'gateway-and', 'human'].map((t) => react.createElement('button', { key: t, className: 'knj-btn', style: { marginBottom: 6 }, onClick: () => this.addNode(t) }, NODE_LABEL[t] || t)),
							react.createElement('div', { className: 'knj-form-label', style: { marginTop: 12 } }, '说明'),
							react.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 } }, '拖节点移动；从节点右侧圆点拖到目标节点连线；点节点编辑配置；点边编辑条件。'),
						),
						react.createElement('div', { className: 'knj-ge-canvas' },
							this.renderSvg(),
						),
						react.createElement('div', { className: 'knj-ge-resizer', onMouseDown: (e) => this.startResize(e), title: '拖拽调整配置区宽度' }),
						react.createElement('div', { className: 'knj-ge-props' },
							selected
								? this.renderNodeProps(selected)
								: this.state.selectedEdge
									? this.renderEdgeProps()
									: react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, padding: 12 } }, '点击节点编辑配置，点击连线可删除'),
						),
					),
					this.state.showGuide ? this.renderGuideModal() : null,
					this.state.showNodeGuide ? this.renderNodeGuideModal() : null,
					this.state.tooltip ? react.createElement('div', { style: { position: 'fixed', left: this.state.tooltip.x + 14, top: this.state.tooltip.y + 14, zIndex: 1400, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '8px 10px', fontSize: 12, color: 'var(--dsw-alias-label-primary)', maxWidth: 340, boxShadow: 'var(--dsw-shadow-lv3)', pointerEvents: 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, this.state.tooltip.text) : null,
				);
			}
			renderGuideModal() {
				const sec = (title, rows) => react.createElement('div', { style: { marginBottom: 14 } },
					react.createElement('div', { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 6 } }, title),
					react.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.8 } }, rows.map((r, i) => react.createElement('div', { key: i, style: { marginBottom: 4 } }, r))),
				);
				return react.createElement('div', { className: 'knj-overlay', style: { zIndex: 1200 } },
					react.createElement('div', { className: 'knj-panel', style: { width: 'min(760px, 92vw)', maxHeight: '86vh' } },
						react.createElement('div', { className: 'knj-head' },
							react.createElement('h2', null, '工作流配置说明'),
							react.createElement('button', { className: 'knj-close', onClick: () => this.setState({ showGuide: false }) }, '关闭'),
						),
						react.createElement('div', { className: 'knj-body' },
							sec('节点（阶段）', [
								'标题：节点在画布和阶段列表里显示的名称，如「需求分析」。',
								'编码（id）：节点的唯一标识，下游用 ${编码.字段} 引用（如 ${analyze.description}）。新建节点时自动生成，可改；改后旧引用需手动更新。',
							]),
							sec('行为 prompt（task 节点）', [
								'本节点让 AI 做什么，写清楚目标和约束。',
								'可引用：${inputDescription}（任务需求描述）、${inputTitle}（标题）、${上游编码.字段}（上游输出，如 ${analyze.description}）、${inputs.参数名}（任务输入）。',
								'执行方式：single 一个 AI 完成；parallel 派多个 AI 并行（结果合并为数组）。',
								'最大执行次数：本节点在一轮任务里最多执行几次（默认 3）。驳回重做 / 循环连线会重复执行节点，超过上限本轮失败——自动防死循环，无需其他配置。',
							]),
							sec('节点输出（本阶段产物）', [
								'定义本节点完成后的输出字段：字段名、类型、说明。',
								'下游阶段用 ${编码.字段} 引用；网关用字段值做分支判断（如 level eq high）。',
								'布尔 / 数组 / 枚举建议显式指定类型，判断才可靠。',
							]),
							sec('网关（分支 / 并行）', [
								'XOR（多选一）：按条件走一条分支——给边配 when（字段 + 比较值），如 level eq high → 设计。',
								'AND（全走）：并行执行多条分支，全部完成后合并继续。',
								'条件值可引用任务变量，如 ${inputs.level}。',
							]),
							sec('人工审批（human 节点）', [
								'展示产物：审批时显示哪个上游节点的输出（如 verify）。',
								'去向（可多条）：每条 = 标签 + 目标节点 + 色调。运行到本节点时暂停等待，审批界面每个去向一个按钮（标签即按钮文字），点击后走到对应目标。',
								'可附意见（可选）：填写的意见会注入去向目标节点，供后续 agent 参考。',
							]),
							sec('连线与条件', [
								'从节点右侧圆点拖到目标节点即可连线。',
								'点连线可编辑条件（when）：字段 + 比较方式（等于/不等于/包含）+ 值。',
								'配了条件的最先命中；都不命中走 default（带「默认」标记的边）。',
							]),
							sec('prehook / posthook（执行前后动作）', [
								'节点执行前/后可执行额外动作（如 git pull、写文件）。可选，通常不用配。',
							]),
						),
					),
				);
			}
			/** 节点配置手册：只讲节点各字段（区别于顶部「工作流配置说明」） */
			renderNodeGuideModal() {
				const sec = (title, rows) => react.createElement('div', { style: { marginBottom: 14 } },
					react.createElement('div', { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 6 } }, title),
					react.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.8 } }, rows.map((r, i) => react.createElement('div', { key: i, style: { marginBottom: 4 } }, r))),
				);
				return react.createElement('div', { className: 'knj-overlay', style: { zIndex: 1200 } },
					react.createElement('div', { className: 'knj-panel', style: { width: 'min(680px, 92vw)', maxHeight: '86vh' } },
						react.createElement('div', { className: 'knj-head' },
							react.createElement('h2', null, '节点配置说明'),
							react.createElement('button', { className: 'knj-close', onClick: () => this.setState({ showNodeGuide: false }) }, '关闭'),
						),
						react.createElement('div', { className: 'knj-body' },
							sec('通用字段（所有节点）', [
								'节点标题：节点在画布和阶段列表里的显示名，如「需求分析」。仅展示用，不影响逻辑。',
								'节点编码（id）：唯一标识，下游用 ${编码.字段} 引用（如 ${analyze.description}）。修改后旧的 ${旧编码.字段} 引用需手动更新。',
							]),
							sec('行为 prompt（task 节点）', [
								'本节点让 AI 做什么，写清目标与约束。',
								'可引用：${inputDescription}（任务需求描述）、${inputTitle}（标题）、${storyCode}（用户故事编码）、${cwd}（任务工作目录）、${inputs.参数名}（任务输入）。',
								'运行时每个 task 节点会自动声明任务工作目录（所有文件/命令操作都在其中）。',
								'需要 skill 时在 prompt 里直接写「先调用 skill 工具加载 skill「xxx」」。',
								'上游输出引用（${上游编码.字段}）：',
								...this.buildRefsText(this.state.wf.nodes.find((n) => n.id === this.state.selectedId)).split('\n').map((s) => '　' + s),
								'注意：XOR 分支未执行的节点引用为空；整节点输出用 ${节点id}；${ctx.前缀写法仍兼容。',
							]),
							sec('执行方式', [
								'single：一个 AI 完成本阶段，输出单个对象。',
								'parallel：派多个 AI 并行做同一件事，结果合并为数组（每个分片写不同 stage 文件）。',
							]),
							sec('最大执行次数', [
								'本节点在一轮任务里最多执行几次（默认 3：首次 + 最多 2 次重跑）。',
								'驳回重做 / 循环连线会重复执行节点，超过上限本轮失败——自动防死循环，无需其他配置。',
							]),
							sec('节点输出（本阶段产物）', [
								'定义本节点完成后的输出字段：字段名、类型、说明。',
								'下游阶段用 ${编码.字段} 引用；网关用字段值做分支判断（如 level eq high）。',
								'布尔 / 数组 / 枚举建议显式指定类型，判断才可靠；字段说明（含义/格式/来源）会注入 subagent 的 schema。',
								'并行执行（parallel）时结果合并为数组。',
							]),
							sec('prehook / posthook（执行前后动作）', [
								'节点执行前/后可执行额外动作（如 git pull、写文件）。可选，通常不用配。',
							]),
							sec('人工节点字段（human）', [
								'展示产物：审批时显示哪个上游节点的输出（如 verify），审批人先看产物再决定。',
								'去向（可多条）：每条 = 标签（审批按钮文字）+ 目标节点 + 色调。运行到本节点时暂停等待，审批界面每个去向一个按钮。',
								'意见：审批时可选填写，会注入去向目标节点，供后续 agent 参考。',
							]),
						),
					),
				);
			}
			onCanvasMove(e) {
				const { drag, linking, wf, panning, resizing } = this.state;
				const canvas = e.currentTarget.querySelector('.knj-ge-canvas');
				if (drag) {
					const node = wf.nodes.find((n) => n.id === drag.id);
					const p = this.canvasPoint(e.clientX, e.clientY);
					const nx = p.x - drag.ox, ny = p.y - drag.oy;
					this.patchNode(drag.id, { x: Math.max(40, nx), y: Math.max(30, ny) }, false); // 拖拽坐标不逐帧记录，onCanvasUp 统一入栈
				} else if (linking) {
					const p = this.canvasPoint(e.clientX, e.clientY);
					const x = p.x, y = p.y;
					let hoverId = null;
					for (const n of wf.nodes) {
						if (n.id === linking.fromId) continue;
						if (Math.abs(x - n.x) < 70 && Math.abs(y - n.y) < 42) { hoverId = n.id; break; }
					}
					this.setState({ linking: { ...linking, x, y }, hoverId });
				} else if (panning) {
					canvas.scrollLeft = panning.sx - (e.clientX - panning.cx);
					canvas.scrollTop = panning.sy - (e.clientY - panning.cy);
				} else if (resizing) {
					const w = Math.min(700, Math.max(260, resizing.sw - (e.clientX - resizing.sx)));
					this.setState({ propsWidth: w });
				}
			}
			onCanvasUp(e) {
				const { drag, linking, panning, resizing } = this.state;
				if (drag) {
					this.setState({ drag: null });
					this.pushNow(this.state.wf); // 拖拽完成提交（拖拽中坐标变更未记录，这里作为一次动作）
				}
				if (linking) {
					const target = this.nodeAt(e.clientX, e.clientY, linking.fromId);
					if (target) {
						const wf = this.state.wf;
						if (!wf.edges.some((ed) => ed.from === linking.fromId && ed.to === target)) {
							wf.edges.push({ from: linking.fromId, to: target });
							this.pushNow(wf); // 新增连线后提交，撤销可移除
							this.setState({ wf });
						}
					}
					this.setState({ linking: null, hoverId: null });
				}
				if (panning) this.setState({ panning: null });
				if (resizing) this.setState({ resizing: null });
			}
			nodeAt(cx, cy, fromId) {
				const p = this.canvasPoint(cx, cy);
				const x = p.x, y = p.y;
				for (const n of this.state.wf.nodes) {
					if (n.id === fromId) continue;
					if (Math.abs(x - n.x) < 70 && Math.abs(y - n.y) < 42) return n.id;
				}
				return null;
			}
			startPan(e) {
				if (e.button !== 0) return;
				const canvas = document.querySelector('.knj-ge-canvas');
				if (!canvas) return;
				this.setState({ panning: { cx: e.clientX, cy: e.clientY, sx: canvas.scrollLeft, sy: canvas.scrollTop } });
			}
			home() {
				this.relayout();
				const canvas = document.querySelector('.knj-ge-canvas');
				if (canvas) { canvas.scrollLeft = 0; canvas.scrollTop = 0; }
				this.setState({ selectedId: null, selectedEdge: null, zoom: 1 });
			}
			zoomBy(delta) {
				const z = Math.min(2, Math.max(0.5, Math.round((this.state.zoom + delta) * 10) / 10));
				this.setState({ zoom: z });
			}
			/** 屏幕坐标 → 画布内容坐标（含滚动偏移 + 缩放比例） */
			canvasPoint(cx, cy) {
				const canvas = document.querySelector('.knj-ge-canvas');
				const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
				const scx = canvas ? canvas.scrollLeft : 0, scy = canvas ? canvas.scrollTop : 0;
				return { x: (cx - rect.left + scx) / this.state.zoom, y: (cy - rect.top + scy) / this.state.zoom };
			}
			startResize(e) {
				e.preventDefault();
				this.setState({ resizing: { sx: e.clientX, sw: this.state.propsWidth } });
			}
			isUpstream(a, b) {
				// a 是否是 b 的上游（沿边可达）→ 用于判断环边（to 可达 from 即构成环）
				const wf = this.state.wf;
				const seen = new Set();
				const dfs = (id) => {
					if (id === a) return true;
					if (seen.has(id)) return false;
					seen.add(id);
					return wf.edges.some((e) => e.from === id && dfs(e.to));
				};
				return dfs(b);
			}
			renderSvg() {
				const { wf, linking, selectedId } = this.state;
				const xs = wf.nodes.map((n) => n.x), ys = wf.nodes.map((n) => n.y);
				const maxX = Math.max(700, ...xs) + 200, maxY = Math.max(420, ...ys) + 200;
				return react.createElement('svg', { className: 'knj-ge-svg', width: maxX * this.state.zoom, height: maxY * this.state.zoom },
					react.createElement('defs', null,
						react.createElement('marker', { id: 'knj-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 11, markerHeight: 11, orient: 'auto' },
							react.createElement('path', { d: 'M0 0L10 5L0 10z', fill: '#5b6472' })),
						react.createElement('marker', { id: 'knj-arrow-red', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 11, markerHeight: 11, orient: 'auto' },
							react.createElement('path', { d: 'M0 0L10 5L0 10z', fill: '#dc2626' })),
						react.createElement('marker', { id: 'knj-arrow-green', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 11, markerHeight: 11, orient: 'auto' },
							react.createElement('path', { d: 'M0 0L10 5L0 10z', fill: '#16a34a' })),
						react.createElement('marker', { id: 'knj-arrow-blue', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 11, markerHeight: 11, orient: 'auto' },
							react.createElement('path', { d: 'M0 0L10 5L0 10z', fill: '#2f6bff' })),
						react.createElement('marker', { id: 'knj-arrow-orange', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 11, markerHeight: 11, orient: 'auto' },
							react.createElement('path', { d: 'M0 0L10 5L0 10z', fill: '#d97706' })),
					),
					// 空白区域：按下拖拽平移画布
					react.createElement('rect', { x: 0, y: 0, width: maxX, height: maxY, fill: 'transparent', onMouseDown: (e) => this.startPan(e), style: { cursor: 'grab' } }),
					wf.edges.map((e) => this.renderEdge(e)),
					this.renderHumanEdges(),
					wf.nodes.map((n) => this.renderNode(n, selectedId === n.id)),
					linking ? this.renderLinking(linking) : null,
				);
			}
			renderLinking(linking) {
				const from = this.state.wf.nodes.find((n) => n.id === linking.fromId);
				if (!from) return null;
				const sx = from.type === 'start' ? from.x + 30 : from.x + 60, sy = from.y, tx = linking.x, ty = linking.y;
				const mx = (sx + tx) / 2;
				const d = `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`;
				return react.createElement('path', { d, fill: 'none', stroke: '#2f6bff', strokeWidth: 2, strokeDasharray: '6 4', markerEnd: 'url(#knj-arrow-blue)' });
			}
			halfW(n) {
				// 连线端点半宽：网关是菱形（半对角线 30），start/end 是胶囊（半宽 30），其余是矩形（半宽 60）
				if (n.type === 'gateway-xor' || n.type === 'gateway-and') return 30;
				if (n.type === 'start' || n.type === 'end') return 30;
				return 60;
			}
			renderEdge(e) {
				const wf = this.state.wf;
				const from = wf.nodes.find((n) => n.id === e.from), to = wf.nodes.find((n) => n.id === e.to);
				if (!from || !to) return null;
				const key = e.from + '->' + e.to;
				const isSel = this.state.selectedEdge === key;
				const cyc = this.isUpstream(e.to, e.from); // 环边：to 可达 from（如人工驳回后重跑链路）
				const sx = from.x + this.halfW(from), sy = from.y, tx = to.x - this.halfW(to), ty = to.y;
				const mx = (sx + tx) / 2, my = (sy + ty) / 2; // 贝塞尔曲线中点，标签放这里
				const d = `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`;
				const pick = (ev) => { ev.stopPropagation(); this.setState({ selectedEdge: key, selectedId: null }); };
				return react.createElement('g', { key },
					// 透明点击区域（加宽，便于选边）
					react.createElement('path', { d, fill: 'none', stroke: 'transparent', strokeWidth: 16, onClick: pick, style: { cursor: 'pointer' } }),
					// 可见线
					react.createElement('path', { d, fill: 'none', stroke: cyc ? '#dc2626' : (isSel ? '#2f6bff' : '#5b6472'), strokeWidth: isSel ? 3 : 2, ...(cyc ? { strokeDasharray: '5 3' } : {}), markerEnd: cyc ? 'url(#knj-arrow-red)' : (isSel ? 'url(#knj-arrow-blue)' : 'url(#knj-arrow)') }),
					(e.when || e.default) ? react.createElement('g', { onClick: pick, style: { cursor: 'pointer' } },
						react.createElement('rect', { x: mx - 44, y: my - 11, width: 88, height: 18, rx: 4, fill: '#fff', stroke: e.default ? '#16a34a' : (isSel ? '#2f6bff' : '#e2e6ec') }),
						react.createElement('text', { x: mx, y: my + 1, fontSize: 10, textAnchor: 'middle', fill: e.default ? '#16a34a' : '#5b6472' },
							e.default && e.when ? `default · ${e.when.field} ${e.when.op} ${JSON.stringify(e.when.value)}` : (e.default ? 'default' : (e.when ? `${e.when.field} ${e.when.op} ${JSON.stringify(e.when.value)}` : ''))),
					) : null,
				);
			}
			renderHumanEdges() {
				const wf = this.state.wf;
				const lines = [];
				for (const n of wf.nodes) {
					if (n.type !== 'human') continue;
					humanRoutes(n).forEach((route, i) => {
						if (route.to) lines.push({ from: n.id, to: route.to, route, index: i });
					});
				}
				return lines.map((he) => this.renderHumanEdge(he));
			}
			renderHumanEdge(he) {
				const wf = this.state.wf;
				const from = wf.nodes.find((n) => n.id === he.from), to = wf.nodes.find((n) => n.id === he.to);
				if (!from || !to) return null;
				const color = routeColor(he.route);
				const key = 'human:' + he.from + ':' + he.index;
				const isSel = this.state.selectedEdge === key;
				const sx = from.x + this.halfW(from), sy = from.y, tx = to.x - this.halfW(to), ty = to.y;
				const mx = (sx + tx) / 2, my = (sy + ty) / 2; // 贝塞尔曲线中点，标签放这里
				const d = `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`;
				const pick = (ev) => { ev.stopPropagation(); this.setState({ selectedEdge: key, selectedId: null }); };
				const label = he.route.label || '去向';
				const markerEnd = ({ success: 'url(#knj-arrow-green)', danger: 'url(#knj-arrow-red)', warning: 'url(#knj-arrow-orange)', info: 'url(#knj-arrow-blue)', neutral: 'url(#knj-arrow)' })[he.route.tone] || 'url(#knj-arrow-blue)';
				return react.createElement('g', { key },
					// 透明点击区域（加宽，便于选中）
					react.createElement('path', { d, fill: 'none', stroke: 'transparent', strokeWidth: 16, onClick: pick, style: { cursor: 'pointer' } }),
					react.createElement('path', { d, fill: 'none', stroke: color, strokeWidth: isSel ? 3 : 2, strokeDasharray: '5 4', markerEnd }),
					react.createElement('g', { onClick: pick, style: { cursor: 'pointer' } },
						react.createElement('rect', { x: mx - 26, y: my - 11, width: 52, height: 16, rx: 3, fill: '#fff', stroke: isSel ? '#2f6bff' : color, strokeWidth: isSel ? 2 : 1 }),
						react.createElement('text', { x: mx, y: my + 1, fontSize: 10, textAnchor: 'middle', fill: color }, label.length > 5 ? label.slice(0, 5) + '…' : label),
					),
				);
			}
			renderNode(n, isSel) {
				const colors = { task: '#5b6472', 'gateway-xor': '#2f6bff', 'gateway-and': '#16a34a', human: '#7c5cff', start: '#8b95a5', end: '#8b95a5' };
				const c = colors[n.type] || '#5b6472';
				// 人工节点去向缺失 → 红色描边 + 角标警示
				const needTarget = n.type === 'human' && humanRoutesIncomplete(n);
				const body = (() => {
					if (n.type === 'gateway-xor' || n.type === 'gateway-and') {
						const half = 30;
						return react.createElement('g', null,
							react.createElement('path', { d: `M ${n.x} ${n.y - half} L ${n.x + half} ${n.y} L ${n.x} ${n.y + half} L ${n.x - half} ${n.y} Z`, fill: '#fff', stroke: c, strokeWidth: 1.6 }),
							react.createElement('path', { d: n.type === 'gateway-xor' ? `M ${n.x - 9} ${n.y - 9} h18 M ${n.x - 9} ${n.y + 9} h18` : `M ${n.x - 9} ${n.y} h18`, stroke: c, strokeWidth: 1.3 }),
						);
					}
					const w = 120, h = 44;
					if (n.type === 'start' || n.type === 'end') {
						return react.createElement('rect', { x: n.x - 30, y: n.y - 18, width: 60, height: 36, rx: 18, fill: '#fff', stroke: c, strokeWidth: 1.5 });
					}
					return react.createElement('rect', { x: n.x - w / 2, y: n.y - h / 2, width: w, height: h, rx: 8, fill: n.type === 'human' ? '#f0ecff' : '#fff', stroke: needTarget ? '#dc2626' : c, strokeWidth: needTarget ? 2 : 1.6 });
				})();
				const label = (() => {
					if (n.type === 'gateway-xor' || n.type === 'gateway-and') return null;
					const txt = n.type === 'start' ? '开始' : n.type === 'end' ? '结束' : (n.title || n.id);
					return react.createElement('text', { x: n.x, y: n.y + 4, fontSize: 12, textAnchor: 'middle', fill: '#181b21' }, txt.length > 10 ? txt.slice(0, 10) + '…' : txt);
				})();
				const isHover = this.state.linking && this.state.hoverId === n.id;
				// 节点类型图标（左上角）：task 齿轮 / human 小人（用节点描边色）
				const typeIcon = (n.type === 'task' || n.type === 'human')
					? react.createElement('g', { transform: `translate(${n.x - 52}, ${n.y - 14})` },
						react.createElement('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none' },
							n.type === 'human'
								? [
									react.createElement('circle', { key: 'h1', cx: 8, cy: 5.5, r: 3, stroke: c, strokeWidth: 1.6 }),
									react.createElement('path', { key: 'h2', d: 'M2.5 13.5c0-3 2.5-4.5 5.5-4.5s5.5 1.5 5.5 4.5', stroke: c, strokeWidth: 1.6, strokeLinecap: 'round' }),
								  ]
								: [
									react.createElement('circle', { key: 'g1', cx: 8, cy: 8, r: 2.2, stroke: c, strokeWidth: 1.5 }),
									react.createElement('path', { key: 'g2', d: 'M8 1.5v2.3M8 12.2v2.3M1.5 8h2.3M12.2 8h2.3M3.4 3.4l1.6 1.6M11 11l1.6 1.6M12.6 3.4L11 5M5 11l-1.6 1.6', stroke: c, strokeWidth: 1.5, strokeLinecap: 'round' }),
								  ],
						),
					)
					: null;
				return react.createElement('g', { key: n.id, onMouseDown: (e) => this.startDrag(n.id, e), onClick: (e) => { e.stopPropagation(); this.setState({ selectedId: n.id, selectedEdge: null }); }, style: { cursor: 'move' } },
					react.createElement('rect', { x: n.x - 62, y: n.y - 24, width: 124, height: 48, fill: isSel ? 'rgba(47,107,255,0.08)' : (isHover ? 'rgba(47,107,255,0.14)' : 'transparent'), stroke: isSel ? '#2f6bff' : (isHover ? '#2f6bff' : 'none'), strokeWidth: isHover ? 2 : 1, strokeDasharray: isHover ? '4 3' : undefined, rx: 10 }),
					body,
					label,
					typeIcon,
					needTarget ? react.createElement('g', null,
						react.createElement('circle', { cx: n.x + 52, cy: n.y - 14, r: 5, fill: '#dc2626' }),
						react.createElement('title', null, '人工节点缺少有效去向（标签 + 目标节点），点节点配置'),
					) : null,
					// 连线端口（右侧圆点，hover 时高亮）
					n.type !== 'end' ? react.createElement('g', { onMouseDown: (e) => this.startLink(n.id, e), style: { cursor: 'crosshair' } },
						react.createElement('circle', { cx: n.x + 60, cy: n.y, r: 7, fill: '#2f6bff', opacity: 0.9 }),
						react.createElement('circle', { cx: n.x + 60, cy: n.y, r: 2.5, fill: '#fff' }),
					) : null,
				);
			}
			renderEdgeProps() {
				const key = this.state.selectedEdge;
				// 人工决策边（多去向）：key 形如 human:<nodeId>:<index>
				if (key.startsWith('human:')) return this.renderHumanEdgeProps(key);
				const [from, to] = key.split('->');
				const edge = this.state.wf.edges.find((e) => e.from === from && e.to === to);
				if (!edge) return null;
				// 节点有多条出边时，非默认边需要条件（XOR 网关 / task 多出边一视同仁）
				const outCount = this.state.wf.edges.filter((e) => e.from === from).length;
				const needCondition = outCount > 1;
				return react.createElement('div', { className: 'knj-ge-props-inner' },
					react.createElement('div', { className: 'knj-form-label' }, '连线'),
					react.createElement('div', { style: { fontSize: 13 } }, `${from} → ${to}`),
					needCondition ? react.createElement('div', null,
						react.createElement('div', { className: 'knj-form-label', style: { marginTop: 10 } }, '条件（when）',
						react.createElement('span', { onMouseEnter: (e) => this.showTip(e, '字段三种写法：\n· 裸字段名（如 level）——相对作用域：网关取唯一上游输出、任务多出边取自身输出\n· ${节点id.字段}（如 ${verify.passed}）——显式引用任意已执行节点，取原始值（布尔/数字直接比较）\n· 裸点号路径（如 verify.passed）——同上\n\n值：布尔/数字自动识别（true/false/5 存为真值）；支持 ${inputs.参数名} 引用；in 用逗号分隔。'), onMouseLeave: () => this.hideTip(), style: { cursor: 'help', color: 'var(--dsw-alias-label-tertiary)', marginLeft: 6, fontSize: 12 } }, 'ⓘ'),
					),
						react.createElement('input', { className: 'knj-input', placeholder: '字段名（如 level；判断任意上游写 ${节点id.字段}）', value: edge.when?.field || '', onChange: (e) => this.patchEdge(key, { when: { op: 'eq', value: '', ...edge.when, field: e.target.value } }) }),
						react.createElement('div', { className: 'knj-row', style: { marginTop: 8 } },
							react.createElement('select', { className: 'knj-input', style: { maxWidth: 120 }, value: edge.when?.op || 'eq', onChange: (e) => this.patchEdge(key, { when: { field: '', ...edge.when, op: e.target.value } }) },
								react.createElement('option', { value: 'eq' }, '等于'),
								react.createElement('option', { value: 'neq' }, '不等于'),
								react.createElement('option', { value: 'in' }, '属于'),
							),
							react.createElement('input', { className: 'knj-input', placeholder: '值（布尔/数字自动识别；in 用逗号分隔；支持 ${inputs.x}）', value: this.valueToText(edge.when?.value), onChange: (e) => this.patchEdge(key, { when: { ...edge.when, value: e.target.value } }) }),
						),
						edge.when ? react.createElement('button', { className: 'knj-btn', style: { alignSelf: 'flex-start', marginTop: 6 }, onClick: () => this.patchEdge(key, { when: null }) }, '清除条件') : null,
					) : react.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginTop: 8 } }, '顺序边，无需条件判断'),
					// default 标记：节点有多条出边时可指定默认边（兜底；配了条件也参与匹配）
					outCount > 1 ? react.createElement('div', { className: 'knj-row', style: { marginTop: 10 } },
						react.createElement('label', { style: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--dsw-alias-label-primary)' } },
							react.createElement('input', { type: 'checkbox', checked: !!edge.default, onChange: (e) => this.patchEdge(key, { default: e.target.checked }) }),
							'默认边（兜底：条件都不满足时走它；配了条件也参与匹配）',
						),
					) : null,
					react.createElement('button', { className: 'knj-btn danger', style: { alignSelf: 'flex-start', marginTop: 10 }, onClick: () => this.removeEdge(key) }, '删除连线'),
				);
			}
			/** 人工决策边面板：改去向（标签/目标/色调），或删除该去向 */
			renderHumanEdgeProps(key) {
				const parts = key.split(':');
				const nodeId = parts[1];
				const index = parseInt(parts[2], 10);
				const node = this.state.wf.nodes.find((n) => n.id === nodeId);
				if (!node) return null;
				const routes = humanRoutes(node);
				const route = routes[index];
				if (!route) return null;
				const color = routeColor(route);
				const targets = this.state.wf.nodes.filter((n) => n.id !== nodeId && n.type !== 'start').map((n) => n.id);
				return react.createElement('div', { className: 'knj-ge-props-inner' },
					react.createElement('div', { className: 'knj-form-label' }, '人工决策去向'),
					react.createElement('div', { style: { fontSize: 13 } }, `人工节点「${node.title || nodeId}」`),
					react.createElement('div', { className: 'knj-row', style: { marginTop: 8, gap: 8 } },
						react.createElement('input', { className: 'knj-input', style: { flex: 1 }, placeholder: '去向标签（审批按钮文字）', value: route.label || '', onChange: (e) => this.patchRoute(nodeId, index, { label: e.target.value }) }),
						react.createElement('select', { className: 'knj-input', style: { maxWidth: 96 }, value: route.tone || 'info', onChange: (e) => this.patchRoute(nodeId, index, { tone: e.target.value }) },
							react.createElement('option', { value: 'success' }, '通过色'),
							react.createElement('option', { value: 'danger' }, '驳回色'),
							react.createElement('option', { value: 'warning' }, '警告色'),
							react.createElement('option', { value: 'info' }, '信息色'),
							react.createElement('option', { value: 'neutral' }, '中性'),
						),
					),
					react.createElement('select', { className: 'knj-input', style: { marginTop: 8 }, value: route.to || '', onChange: (e) => this.patchRoute(nodeId, index, { to: e.target.value }) },
						route.to && !targets.includes(route.to) ? react.createElement('option', { value: route.to }, route.to + '（不存在）') : null,
						targets.map((t) => react.createElement('option', { key: t, value: t }, t)),
					),
					react.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 8, lineHeight: 1.6 } },
						'审批时该去向显示为一个按钮（标签即按钮文字），点击后流程走到目标节点；填写的意见会注入目标节点。',
					),
					react.createElement('button', { className: 'knj-btn danger', style: { alignSelf: 'flex-start', marginTop: 10 }, onClick: () => this.removeRoute(nodeId, index) }, '删除该去向'),
				);
			}
			patchRoute(nodeId, index, patch) {
				const wf = this.state.wf;
				const node = wf.nodes.find((n) => n.id === nodeId);
				if (!node) return;
				const routes = humanRoutes(node).map((r, i) => i === index ? { ...r, ...patch } : r);
				this.patchNode(nodeId, { routes }); // patchNode 内部已做防抖提交
			}
			removeRoute(nodeId, index) {
				const wf = this.state.wf;
				const node = wf.nodes.find((n) => n.id === nodeId);
				if (!node) return;
				const routes = humanRoutes(node).filter((_, i) => i !== index);
				wf.nodes = wf.nodes.map((n) => n.id === nodeId ? { ...n, routes } : n);
				this.pushNow(wf); // 删除后提交，撤销可恢复
				this.setState({ wf, selectedEdge: null });
			}
			addRoute(nodeId) {
				const wf = this.state.wf;
				const node = wf.nodes.find((n) => n.id === nodeId);
				if (!node) return;
				const routes = [...humanRoutes(node), { label: '', to: '', tone: 'info' }];
				wf.nodes = wf.nodes.map((n) => n.id === nodeId ? { ...n, routes } : n);
				this.pushNow(wf); // 新增后提交，撤销可移除
				this.setState({ wf });
			}
			/** 去向编辑行：标签 + 色调 + 目标 + 删除 */
			renderRouteRow(node, route, i) {
				const targets = this.state.wf.nodes.filter((n) => n.id !== node.id && n.type !== 'start').map((n) => n.id);
				const color = routeColor(route);
				return react.createElement('div', { key: i, className: 'knj-stage-row', style: { alignItems: 'flex-start', gap: 6, marginBottom: 6 } },
					react.createElement('input', { className: 'knj-input', style: { flex: 'none', width: 72, borderColor: route.to ? undefined : '#dc2626' }, placeholder: '标签', value: route.label || '', onChange: (e) => this.patchRoute(node.id, i, { label: e.target.value }) }),
					react.createElement('select', { className: 'knj-input', style: { flex: 'none', width: 84 }, value: route.tone || 'info', onChange: (e) => this.patchRoute(node.id, i, { tone: e.target.value }) },
						react.createElement('option', { value: 'success' }, '通过色'),
						react.createElement('option', { value: 'danger' }, '驳回色'),
						react.createElement('option', { value: 'warning' }, '警告色'),
						react.createElement('option', { value: 'info' }, '信息色'),
						react.createElement('option', { value: 'neutral' }, '中性'),
					),
					react.createElement('select', { className: 'knj-input', style: { flex: 1, borderColor: route.to ? undefined : '#dc2626' }, value: route.to || '', onChange: (e) => this.patchRoute(node.id, i, { to: e.target.value }) },
						route.to ? null : react.createElement('option', { value: '' }, '选择目标节点…'),
						targets.map((t) => react.createElement('option', { key: t, value: t }, t)),
					),
					react.createElement('button', { className: 'knj-btn', style: { flex: 'none', padding: '0 8px', height: 26, fontSize: 11 }, title: '删除该去向', onClick: () => this.removeRoute(node.id, i) }, '✕'),
				);
			}
			patchEdge(key, patch) {
				this.scheduleCommit(); // 条件输入防抖合并
				const [from, to] = key.split('->');
				const wf = this.state.wf;
				wf.edges = wf.edges.map((e) => e.from === from && e.to === to ? { ...e, ...patch } : e);
				this.setState({ wf });
			}
			valueToText(v) {
				if (v == null) return '';
				if (Array.isArray(v)) return v.join(',');
				return String(v);
			}
			removeEdge(key) {
				const [from, to] = key.split('->');
				const wf = this.state.wf;
				wf.edges = wf.edges.filter((e) => !(e.from === from && e.to === to));
				this.pushNow(wf); // 删除后提交，撤销可恢复
				this.setState({ wf, selectedEdge: null });
			}
			addAction(nodeId, hookType) {
				const node = this.state.wf.nodes.find((n) => n.id === nodeId);
				if (!node) return;
				const list = node[hookType] || [];
				this.patchNode(nodeId, { [hookType]: [...list, { type: 'builtin', name: 'git-checkout', params: { branch: '' }, as: '' }] });
			}
			removeAction(nodeId, hookType, index) {
				const node = this.state.wf.nodes.find((n) => n.id === nodeId);
				if (!node) return;
				this.patchNode(nodeId, { [hookType]: (node[hookType] || []).filter((_, i) => i !== index) });
			}
			patchAction(nodeId, hookType, index, patch) {
				const node = this.state.wf.nodes.find((n) => n.id === nodeId);
				if (!node) return;
				this.patchNode(nodeId, { [hookType]: (node[hookType] || []).map((a, i) => i === index ? { ...a, ...patch } : a) });
			}
			commitParams(nodeId, hookType, index, text) {
				try {
					const parsed = text.trim() ? JSON.parse(text) : {};
					this.patchAction(nodeId, hookType, index, { params: parsed });
				} catch { /* 忽略，保持原值 */ }
			}
			renderAction(node, hookType, index, action) {
				const isBuiltin = action.type !== 'exec';
				return react.createElement('div', { key: index, className: 'knj-card', style: { flexDirection: 'column', alignItems: 'stretch', gap: 6 } },
					react.createElement('div', { className: 'knj-row', style: { marginBottom: 0 } },
						react.createElement('select', { className: 'knj-input', style: { maxWidth: 108 }, value: isBuiltin ? 'builtin' : 'exec', onChange: (e) => this.patchAction(node.id, hookType, index, e.target.value === 'builtin' ? { type: 'builtin', name: 'git-checkout', params: { branch: '' } } : { type: 'exec', prompt: '', output: {} }) },
							react.createElement('option', { value: 'builtin' }, '内置动作'),
							react.createElement('option', { value: 'exec' }, '执行式'),
						),
						isBuiltin ? react.createElement('select', { className: 'knj-input', style: { flex: 1 }, value: action.name || 'git-checkout', onChange: (e) => this.patchAction(node.id, hookType, index, { name: e.target.value }) },
							BUILTIN_ACTIONS_CLIENT.map((b) => react.createElement('option', { key: b.name, value: b.name }, `${b.label}（${b.name}）`)),
						) : null,
						react.createElement('button', { className: 'knj-btn danger', style: { padding: '0 8px', flex: 'none' }, onClick: () => this.removeAction(node.id, hookType, index) }, '×'),
					),
					isBuiltin
						? react.createElement('textarea', { key: `${node.id}-${hookType}-${index}-params`, className: 'knj-textarea', style: { minHeight: 50, fontSize: 12 }, placeholder: '参数 JSON，如 {"branch":"main"}', defaultValue: JSON.stringify(action.params || {}), onBlur: (e) => this.commitParams(node.id, hookType, index, e.target.value) })
						: react.createElement('textarea', { className: 'knj-textarea', style: { minHeight: 60 }, placeholder: '自然语言描述（如：根据工单号查 API 拿分支）', value: action.prompt || '', onChange: (e) => this.patchAction(node.id, hookType, index, { prompt: e.target.value }) }),
					react.createElement('input', { className: 'knj-input', placeholder: 'as 命名（输出进 ctx，可选）', value: action.as || '', onChange: (e) => this.patchAction(node.id, hookType, index, { as: e.target.value }) }),
				);
			}
			renderHookSection(node, hookType, title) {
				const actions = node[hookType] || [];
				return react.createElement('div', null,
					react.createElement('div', { className: 'knj-form-label', style: { marginTop: 12 } }, title),
					actions.map((a, i) => this.renderAction(node, hookType, i, a)),
					react.createElement('button', { className: 'knj-btn', style: { width: '100%', borderStyle: 'dashed' }, onClick: () => this.addAction(node.id, hookType) }, '＋ 添加动作'),
				);
			}
			/** 生成"可引用的上游输出"文本（供行为 prompt 的 ⓘ hover 与节点字段手册使用） */
			buildRefsText(node) {
				const wf = this.state.wf;
				const refs = wf.nodes
					.filter((n) => n.type === 'task' && n.id !== node?.id)
					.map((n) => ({ title: n.title, id: n.id, fields: this.fieldOptionsOf(n) }))
					.filter((r) => r.fields.length > 0);
				if (refs.length === 0) return '（暂无其他 task 节点的输出可引用）';
				return refs.map((r) => `${r.title}（${r.id}）：${r.fields.map((f) => '${' + r.id + '.' + f + '}').join('、')}`).join('\n');
			}
			fieldOptionsOf(node) {
				const output = node && node.body ? node.body.output : null;
				if (!output || output.type !== 'object' || !output.properties) return [];
				return Object.keys(output.properties);
			}
			renderNodeProps(node) {
				const isTask = node.type === 'task';
				// 字段区 = 标题 + 一行精简说明（直接可见）+ 输入控件；完整细节在 ⓘ hover 里
				const fieldLabel = (text, tip, desc) => react.createElement('div', { style: { marginBottom: 4 } },
					react.createElement('div', { className: 'knj-form-label' }, text,
						tip ? react.createElement('span', { onMouseEnter: (e) => this.showTip(e, tip), onMouseLeave: () => this.hideTip(), style: { cursor: 'help', color: 'var(--dsw-alias-label-tertiary)', marginLeft: 6, fontSize: 12 } }, 'ⓘ') : null,
					),
					desc ? react.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.5, marginBottom: 4 } }, desc) : null,
				);
				return react.createElement('div', { className: 'knj-ge-props-inner' },
					react.createElement('div', { className: 'knj-form-label' }, '节点配置',
						react.createElement('span', { onClick: () => this.setState({ showNodeGuide: true }), style: { cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', marginLeft: 8, fontSize: 12, textDecoration: 'underline' }, title: '节点各字段的配置说明（区别于顶部「工作流配置说明」）' }, '❓ 字段说明'),
					),
					fieldLabel('节点标题（显示名）', '节点在画布和阶段列表里显示的名称，如「需求分析」。仅作展示，不影响引用。', '画布与阶段列表里的显示名'),
					react.createElement('input', { className: 'knj-input', style: { marginBottom: 8 }, placeholder: '如：需求分析', value: node.title || '', onChange: (e) => this.patchNode(node.id, { title: e.target.value }) }),
					fieldLabel('节点编码（id）', '节点唯一标识：下游用 ${编码.字段} 引用（如 ${analyze.description}），网关用字段值做分支判断。修改后 prompt 里旧的 ${旧编码.字段} 引用需手动更新。', '下游用 ${编码.字段} 引用，如 ${analyze.description}'),
					react.createElement('input', { className: 'knj-input', style: { marginBottom: 8 }, placeholder: '如：analyze', defaultValue: node.id || '', onBlur: (e) => this.patchNodeId(node.id, e.target.value.trim()) }),
					isTask ? react.createElement('div', null,
						fieldLabel('行为 prompt（主体）', '本节点让 AI 做什么，写清目标与约束。\n可引用：\n${inputDescription}（任务需求描述）\n${inputTitle}（标题）\n${storyCode}（用户故事编码，可选）\n${cwd}（任务工作目录；运行时还会自动向 subagent 声明该目录）\n${inputs.参数名}（任务输入）\n\n上游输出引用（${上游编码.字段}）：\n' + this.buildRefsText(node) + '\n\n注意：XOR 分支未执行的节点引用为空；整节点输出用 ${节点id}；${ctx.前缀写法仍兼容。', '让 AI 做什么；可引用 ${inputDescription}、${storyCode}、${cwd}、${上游编码.字段}（ⓘ 看完整清单）'),
						react.createElement('textarea', { className: 'knj-textarea', style: { minHeight: 140 }, placeholder: '如：根据需求 ${inputDescription} 输出功能描述与验收标准', value: node.body?.prompt || '', onChange: (e) => this.patchNode(node.id, { body: { ...node.body, prompt: e.target.value } }) }),
						fieldLabel('执行方式', 'single：一个 AI 完成本阶段，输出单个对象。\nparallel：派多个 AI 并行做同一件事，结果合并为数组（配合「最大执行次数」外的 parallelItems 使用，见输出说明）。', 'single：单个 AI 完成；parallel：多个 AI 并行，结果合并为数组'),
						react.createElement('select', { className: 'knj-input', value: node.body?.mode || 'single', onChange: (e) => this.patchNode(node.id, { body: { ...node.body, mode: e.target.value } }) },
							react.createElement('option', { value: 'single' }, 'single'),
							react.createElement('option', { value: 'parallel' }, 'parallel'),
						),
						fieldLabel('最大执行次数', '本节点在一轮任务里最多执行几次（默认 3：首次 + 最多 2 次重跑）。\n驳回重做 / 循环连线会重复执行节点，超过上限本轮失败，防止死循环。', '默认 3（首次 + 最多 2 次重跑），超限本轮失败防死循环'),
						react.createElement('input', { className: 'knj-input', type: 'number', min: 1, style: { maxWidth: 120 }, value: node.maxRuns || 3, onChange: (e) => { const v = parseInt(e.target.value, 10); this.patchNode(node.id, { maxRuns: Number.isInteger(v) && v >= 1 ? v : 3 }); } }),
						this.renderOutputSchema(node),
						this.renderHookSection(node, 'prehook', 'prehook（执行前动作）'),
						this.renderHookSection(node, 'posthook', 'posthook（执行后动作）'),
					) : node.type === 'human' ? react.createElement('div', null,
						humanRoutesIncomplete(node) ? react.createElement('div', { style: { fontSize: 12, color: '#dc2626', marginBottom: 8, lineHeight: 1.6 } }, '⚠ 至少需要一个完整去向（标签 + 目标节点），保存会被拦截，画布上该节点显示红色警示。') : null,
						fieldLabel('展示产物（上游节点 id）', '人工审批时展示哪个上游节点的输出（如 verify），审批人先看产物再决定。', '审批时展示哪个上游节点的输出，如 verify'),
						react.createElement('input', { className: 'knj-input', placeholder: '如 verify', value: node.displayFrom || '', onChange: (e) => this.patchNode(node.id, { displayFrom: e.target.value }) }),
						fieldLabel('去向（审批按钮，可多条）', '运行到本节点时暂停等待人工：每个去向是一个按钮，点击后流程走到对应目标。\n每条 = 标签（按钮文字）+ 目标节点 + 色调。填写的意见会注入目标节点。\n旧配置的「通过/驳回」自动兼容为两条去向。', '每个去向 = 一个审批按钮；可附意见注入目标节点'),
						humanRoutes(node).map((route, i) => this.renderRouteRow(node, route, i)),
						react.createElement('button', { className: 'knj-btn', style: { alignSelf: 'flex-start', marginTop: 6 }, onClick: () => this.addRoute(node.id) }, '+ 添加去向'),
					) : null,
					react.createElement('div', { className: 'knj-row', style: { marginTop: 12 } },
						react.createElement('button', { className: 'knj-btn danger', onClick: () => this.removeNode(node.id) }, '删除节点'),
					),
				);
			}
			renderOutputSchema(node) {
				const output = node.body?.output || {};
				const props = output.properties || {};
				const fields = Object.keys(props);
				return react.createElement('div', null,
					react.createElement('div', { className: 'knj-form-label', style: { marginTop: 10 } }, '节点输出（本阶段产物）',
						react.createElement('span', { onMouseEnter: (e) => this.showTip(e, '定义本节点完成后输出的字段。\n下游阶段用 ${编码.字段} 引用（如 ${complexity.level}），网关用字段值做分支判断（如 level eq high）。\n布尔 / 数组 / 枚举建议显式指定类型，判断才可靠。\n并行执行（parallel）时结果为数组。'), onMouseLeave: () => this.hideTip(), style: { cursor: 'help', color: 'var(--dsw-alias-label-tertiary)', marginLeft: 6, fontSize: 12 } }, 'ⓘ'),
					),
					react.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.5, marginBottom: 4 } }, '本节点的输出字段：下游 ${编码.字段} 引用、网关分支判断；布尔/数组/枚举建议指定类型'),
					react.createElement('input', {
						key: 'out-' + node.id + '-' + fields.join(','),
						className: 'knj-input',
						placeholder: '字段名，多个用逗号分隔（如 level, reason）',
						defaultValue: fields.join(', '),
						onBlur: (e) => this.patchOutputFields(node.id, e.target.value),
					}),
					fields.length > 0 ? react.createElement('div', { className: 'knj-form-label', style: { marginTop: 8 } }, `字段定义（${fields.length}）`) : null,
					fields.map((f) => this.renderOutputField(node, f, props[f])),
					fields.length === 0 ? react.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6, lineHeight: 1.5 } }, '在上方输入字段名（多个用逗号分隔），失焦后即为本节点定义输出字段。') : null,
				);
			}
			renderOutputField(node, field, schema) {
				const type = schema?.type || '';
				const desc = schema?.description || '';
				return react.createElement('div', { key: field, style: { marginBottom: 6 } },
					react.createElement('div', { className: 'knj-stage-row', style: { gap: 6 } },
						react.createElement('span', {
							style: { fontSize: 13, flex: 'none', minWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)' },
						}, field),
						react.createElement('select', { className: 'knj-input', style: { flex: 'none', width: 96 }, value: type, onChange: (e) => this.patchOutputFieldType(node.id, field, e.target.value) },
							react.createElement('option', { value: '' }, '自动'),
							react.createElement('option', { value: 'string' }, 'string'),
							react.createElement('option', { value: 'number' }, 'number'),
							react.createElement('option', { value: 'boolean' }, 'boolean'),
							react.createElement('option', { value: 'array' }, 'array'),
						),
						type === 'string' ? react.createElement('input', { className: 'knj-input', style: { flex: 1, minWidth: 0 }, placeholder: '枚举（逗号分隔，可选）', defaultValue: (schema?.enum || []).join(','), onBlur: (e) => this.patchOutputFieldEnum(node.id, field, e.target.value) }) : null,
					),
					// 字段说明：直接输入框编辑（含义 / 格式 / 来源，注入 subagent 的输出 schema），不再用弹窗
					react.createElement('input', { className: 'knj-input', style: { marginTop: 4, fontSize: 12 }, placeholder: '字段说明（含义 / 格式 / 来源，会注入 subagent 的输出 schema）', value: desc, onChange: (e) => this.patchOutputFieldDescription(node.id, field, e.target.value) }),
				);
			}
			showTip(e, text) {
				this.setState({ tooltip: { text, x: e.clientX, y: e.clientY } });
			}
			hideTip() {
				this.setState({ tooltip: null });
			}
			patchOutputFields(nodeId, text) {
				const fields = String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
				const node = this.state.wf.nodes.find((n) => n.id === nodeId);
				if (!node) return;
				const oldProps = node.body?.output?.properties || {};
				const properties = {};
				for (const f of fields) properties[f] = oldProps[f] || {};
				const output = { type: 'object', properties };
				this.patchNode(nodeId, { body: { ...node.body, output } });
			}
			patchOutputFieldType(nodeId, field, type) {
				const node = this.state.wf.nodes.find((n) => n.id === nodeId);
				if (!node) return;
				const props = { ...(node.body?.output?.properties || {}) };
				const old = props[field] || {};
				if (!type) props[field] = {};
				else props[field] = { ...old, type };
				this.patchNode(nodeId, { body: { ...node.body, output: { type: 'object', properties: props } } });
			}
			patchOutputFieldEnum(nodeId, field, text) {
				const values = String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
				const node = this.state.wf.nodes.find((n) => n.id === nodeId);
				if (!node) return;
				const props = { ...(node.body?.output?.properties || {}) };
				const old = props[field] || {};
				if (values.length) props[field] = { ...old, enum: values };
				else { const { enum: _e, ...rest } = old; props[field] = rest; }
				this.patchNode(nodeId, { body: { ...node.body, output: { type: 'object', properties: props } } });
			}
			patchOutputFieldDescription(nodeId, field, text) {
				const node = this.state.wf.nodes.find((n) => n.id === nodeId);
				if (!node) return;
				const props = { ...(node.body?.output?.properties || {}) };
				const old = props[field] || {};
				if (text.trim()) props[field] = { ...old, description: text.trim() };
				else { const { description: _d, ...rest } = old; props[field] = rest; }
				this.patchNode(nodeId, { body: { ...node.body, output: { type: 'object', properties: props } } });
			}
			schemaToText(s) {
				if (!s || !Object.keys(s).length) return '';
				try { return JSON.stringify(s, null, 2); } catch { return ''; }
			}
			commitSchema(id, text) {
				const node = this.state.wf.nodes.find((n) => n.id === id);
				if (!node) return;
				if (!text.trim()) {
					this.patchNode(id, { body: { ...node.body, output: {} } });
					this.setState({ schemaError: null });
					return;
				}
				try {
					const parsed = JSON.parse(text);
					this.patchNode(id, { body: { ...node.body, output: parsed } });
					this.setState({ schemaError: null });
				} catch (err) {
					this.setState({ schemaError: err instanceof Error ? err.message : String(err) });
				}
			}
			formatSchema(id) {
				const node = this.state.wf.nodes.find((n) => n.id === id);
				if (!node) return;
				const ta = this.schemaRef.current;
				const text = ta ? ta.value : '';
				if (!text.trim()) { this.setState({ schemaError: null }); return; }
				try {
					const parsed = JSON.parse(text);
					const formatted = JSON.stringify(parsed, null, 2);
					if (ta) ta.value = formatted;
					this.patchNode(id, { body: { ...node.body, output: parsed } });
					this.setState({ schemaError: null });
				} catch (err) {
					this.setState({ schemaError: err instanceof Error ? err.message : String(err) });
				}
			}
		}

		const NODE_LABEL = { task: '任务节点', 'gateway-xor': '排他网关', 'gateway-and': '并行网关', human: '人工节点' };
		/** 内置动作库（与 orchestrator.js 的 BUILTIN_ACTIONS 对应，供 UI 下拉选择） */
		const BUILTIN_ACTIONS_CLIENT = [
			{ name: 'git-pull', label: '拉取代码', params: { branch: '', remote: '' } },
			{ name: 'git-checkout', label: '切换分支', params: { branch: '', remote: 'origin' } },
			{ name: 'git-clone', label: '克隆仓库', params: { repo: '', branch: '', dir: '' } },
			{ name: 'mkdir', label: '创建目录', params: { path: '' } },
			{ name: 'write-product', label: '落盘产物', params: { path: '' } },
		];

		function progressPct(t) {
			const steps = t.stageStates || [];
			if (!steps.length) return 0;
			if (t.status === 'success') return 100;
			const relevant = steps.filter((s) => s.status !== 'skipped');
			if (!relevant.length) return 0;
			const done = relevant.filter((s) => s.status === 'done').length;
			return Math.round((done / relevant.length) * 100);
		}

		/** 判断字符串是否像文件路径（含扩展名或路径分隔符，且不太长） */
		function looksLikeFile(s) {
			if (typeof s !== 'string' || !s.trim()) return false;
			const v = s.trim();
			if (v.length > 220) return false;
			if (v.includes(' ')) return false; // 路径不含空格：错误消息（含空格+中文）不会被误判
			// 绝对/相对路径开头（/ ./ ../ 盘符:\ ~/），或纯文件名带扩展名
			return /^(\/|\.{1,2}\/|[A-Za-z]:[\\/]|~\/)/.test(v) || /^\S+\.\w{1,12}$/.test(v);
		}
		/** 从产物（JSON）里收集看起来像文件路径的字符串（去重，限制数量） */
		/** 从产物（JSON）里收集文件路径：只认「文件类字段」的数组元素（changedFiles/affectedFiles/paths 等），
		 *  错误消息/描述等文本字段不收集（避免把错误文案里的路径误判成文件）。去重，限制数量。 */
		function collectFiles(value, out, depth) {
			out = out || new Set();
			depth = depth || 0;
			if (depth > 4 || out.size >= 20) return out;
			if (value === null || value === undefined || typeof value !== 'object') return out;
			if (Array.isArray(value)) {
				// 仅当整体是文件列表数组时（由上层文件字段进入）才收元素；普通数组不递归收字符串
				for (const v of value) {
					if (typeof v === 'string') { if (looksLikeFile(v)) out.add(v.trim()); }
					else collectFiles(v, out, depth + 1);
				}
				return out;
			}
			for (const k of Object.keys(value)) {
				// 字段名暗示文件列表（changedFiles/affectedFiles/files/paths/artifacts 等）→ 收集其数组元素
				if (Array.isArray(value[k]) && /(file|path|src|output|artifact)/i.test(k)) {
					for (const v of value[k]) {
						if (typeof v === 'string') { if (looksLikeFile(v)) out.add(v.trim()); }
						else collectFiles(v, out, depth + 1);
					}
				} else {
					collectFiles(value[k], out, depth + 1);
				}
			}
			return out;
		}

		// ---------------------------------------------------------------------------
		// 插件入口：
		//   1. 左侧栏底部 sidebar.footer.action（list 槽）→「➕ 新建任务」按钮
		//   2. 右侧栏（better-sidebar）→「📋 开发任务」「⚙️ 工作流」两个 tab
		//   3. better-sidebar 缺失时自动降级（保留左侧按钮，不注册 tab）
		// 不再使用对话尾部按钮（conversation.chat.turnTail）。
		// ---------------------------------------------------------------------------
		// ---------------------------------------------------------------------------
		// 新建任务模态（完整表单）+ 中央工作台（子 tab）+ 打开函数
		// ---------------------------------------------------------------------------
		let newTaskRoot = null;
		let newTaskRootHandle = null;
		function openNewTaskModal() {
			ensureStyle();
			if (newTaskRoot) { newTaskRoot.style.display = 'flex'; return; }
			newTaskRoot = document.createElement('div');
			document.body.appendChild(newTaskRoot);
			// 关闭 = 真正卸载：下次打开表单全新（不残留上次填的标题/描述/工作目录/参数）
			const close = () => {
				if (newTaskRootHandle) { newTaskRootHandle.unmount(); newTaskRootHandle = null; }
				if (newTaskRoot) { newTaskRoot.remove(); newTaskRoot = null; }
			};
			newTaskRootHandle = react_dom_client.createRoot(newTaskRoot);
			newTaskRootHandle.render(react.createElement(NewTaskModal, { onClose: close }));
		}

		class NewTaskModal extends react.Component {
			constructor(props) {
				super(props);
				this.state = { description: '', title: '', storyCode: '', workflowId: '', cwd: '', cwdOptions: [], inputs: {}, workflows: [], busy: false, error: null, model: '', provider: '', models: [] };
			}
			componentDidMount() { this.load(); }
			/** 取当前会话的模型/provider 作为表单默认值（用户可改成其他模型，如 glm 额度用完时切 deepseek） */
			currentModelDefaults() {
				try {
					const ag = _ctx?.get?.('agents');
					const init = ag?.currentInitiator?.() ?? ag?.roots?.()?.[0];
					const opts = init?.options || {};
					return { model: opts.model || '', provider: opts.provider || '' };
				} catch { return { model: '', provider: '' }; }
			}
			/** 拉取可用模型列表：直接走 Host 插件 /models（本地解析配置文件，毫秒级）。
			 *  不再尝试 connection.api.llm.models RPC——它会遍历所有 provider 并逐个远端 resolve，
			 *  在 key 失效/网络慢时挂起很久，导致表单"加载半天才出来"。 */
			async loadModels() {
				const list = [];
				try {
					const r = await api('/models');
					for (const m of (r && r.models) || []) list.push(m);
				} catch { /* 失败则留空（仅显示"继承当前会话"） */ }
				const seen = new Set();
				const uniq = list.filter((m) => {
					const k = (m.provider || '') + '::' + (m.model || '');
					if (!m.model || seen.has(k)) return false;
					seen.add(k);
					return true;
				});
				if (uniq.length === 0) console.warn('[knj-workflow] 模型列表为空：/models 未返回模型');
				this.setState({ models: uniq });
			}
			/** 工作目录下拉：异步加载，不阻塞表单渲染（refresh 可能慢/挂起，最多等 3 秒） */
			async loadCwdOptions() {
				try {
					const ws = _ctx?.get?.('workspaces') || _workspaces;
					if (ws && typeof ws.refresh === 'function' && !(ws.list?.getSnapshot?.()?.items || []).length) {
						await Promise.race([
							ws.refresh(),
							new Promise((resolve) => setTimeout(resolve, 3000)),
						]);
					}
					const items = ws?.list?.getSnapshot?.()?.items || [];
					const cwdOptions = [];
					for (const item of items) {
						const view = item?.getSnapshot?.()?.view || item || {};
						const path = view.path || view.cwd || '';
						const title = view.title || view.name || (path ? path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');
						if (path) cwdOptions.push({ path, title: title || path });
					}
					this.setState({ cwdOptions });
				} catch { /* 加载失败保持空 */ }
			}
			async load() {
				try {
					const w = await api('/workflows');
					const workflows = w.workflows || [];
					const def = this.currentModelDefaults();
					// 先渲染表单主体（工作流/默认模型），工作区与模型列表异步填充，不等慢请求
					this.setState({ workflows, workflowId: workflows[0]?.id || '', model: def.model, provider: def.provider, error: null });
					this.loadCwdOptions();
					this.loadModels();
				} catch (e) { this.setState({ error: e.message }); }
			}
			selectedWorkflow() { return this.state.workflows.find((w) => w.id === this.state.workflowId); }
			render() {
				const { description, title, storyCode, workflowId, cwd, cwdOptions, inputs, workflows, busy, error, model, provider } = this.state;
				const wf = this.selectedWorkflow();
				const wfInputs = (wf && Array.isArray(wf.inputs)) ? wf.inputs : [];
				return react.createElement('div', { className: 'knj-overlay' },
					react.createElement('div', { className: 'knj-panel', style: { width: 'min(560px, 94vw)' } },
						react.createElement('div', { className: 'knj-head' },
							react.createElement('h2', null, '新建开发任务'),
							react.createElement('button', { className: 'knj-close', onClick: this.props.onClose }, '关闭'),
						),
						react.createElement('div', { className: 'knj-body' },
							error ? react.createElement('div', { className: 'knj-err' }, '加载失败：' + error) : null,
							react.createElement('div', { className: 'knj-form-section' },
								react.createElement('div', { className: 'knj-form-label' }, '需求描述（必填）'),
								react.createElement('textarea', { className: 'knj-textarea', style: { minHeight: 80 }, placeholder: '描述你要做什么，如：用户可从文件列表勾选多个文件并批量下载', value: description, onChange: (e) => this.setState({ description: e.target.value }) }),
							),
							react.createElement('div', { className: 'knj-form-section' },
								react.createElement('div', { className: 'knj-form-label' }, '标题（创建后自动总结，可改）'),
								react.createElement('input', { className: 'knj-input', placeholder: '留空则创建后自动总结', value: title, onChange: (e) => this.setState({ title: e.target.value }) }),
							),
							react.createElement('div', { className: 'knj-form-section' },
								react.createElement('div', { className: 'knj-form-label', title: '用户故事编号（如 US-123 / STORY-45）。可选；填了之后节点 prompt 里可用 ${storyCode} 引用（如记录到提交信息/文档标题）。' }, '用户故事编码（可选） ⓘ'),
								react.createElement('input', { className: 'knj-input', placeholder: '如 US-123（可留空）', value: storyCode, onChange: (e) => this.setState({ storyCode: e.target.value }) }),
							),
							react.createElement('div', { className: 'knj-form-section' },
								react.createElement('div', { className: 'knj-form-label' }, '工作流'),
								react.createElement('select', { className: 'knj-input', value: workflowId, onChange: (e) => this.setState({ workflowId: e.target.value }) },
									workflows.map((w) => react.createElement('option', { key: w.id, value: w.id }, `${w.name}（${(w.nodes || []).filter((n) => n.type === 'task').length} 阶段）`)),
								),
							),
							react.createElement('div', { className: 'knj-form-section' },
								react.createElement('div', { className: 'knj-form-label' }, '工作目录（可选）'),
								react.createElement('select', { className: 'knj-input', value: cwd, onChange: (e) => this.setState({ cwd: e.target.value }) }, react.createElement('option', { value: '' }, '默认（当前工作区）'), cwdOptions.map((o) => react.createElement('option', { key: o.path, value: o.path, title: o.path }, o.title))),
							),
							wfInputs.length > 0 ? react.createElement('div', { className: 'knj-form-section' },
								react.createElement('div', { className: 'knj-form-label' }, '任务输入参数'),
								wfInputs.map((inp) => react.createElement('input', { key: inp.name, className: 'knj-input', style: { marginBottom: 8 }, placeholder: `${inp.label || inp.name}${inp.required ? '（必填）' : ''}`, value: inputs[inp.name] || '', onChange: (e) => this.setState({ inputs: { ...inputs, [inp.name]: e.target.value } }) })),
							) : null,
							react.createElement('div', { className: 'knj-form-section' },
								react.createElement('div', { className: 'knj-form-label', title: '所有阶段 subagent 都用这个模型执行。默认继承你当前会话的模型（见下拉第一项）。当前模型额度不足时，可在这里换成其他可用模型避免任务失败。' }, '执行模型（可选，留空继承当前会话） ⓘ'),
								react.createElement('select', { className: 'knj-input', value: model ? provider + '::' + model : '', onChange: (e) => {
									const v = e.target.value;
									if (!v) { this.setState({ model: '', provider: '' }); return; }
									const sep = v.indexOf('::');
									this.setState({ provider: v.slice(0, sep), model: v.slice(sep + 2) });
								} },
									// 第一项 = 继承当前会话（显示当前模型名）；列表排除与它重复的模型，避免出现两个一样的选项
									react.createElement('option', { value: '' }, model ? `继承当前会话（${provider}/${model}）` : '继承当前会话（默认）'),
									this.state.models
										.filter((m) => m.provider + '::' + m.model !== (model ? provider + '::' + model : ''))
										.map((m) => react.createElement('option', { key: m.provider + '::' + m.model, value: m.provider + '::' + m.model }, `${m.provider}/${m.model}`)),
								),
							),
							react.createElement('div', { className: 'knj-row', style: { justifyContent: 'flex-end' } },
								react.createElement('button', { className: 'knj-btn', onClick: this.props.onClose }, '取消'),
								react.createElement('button', { className: 'knj-btn primary', disabled: busy || !description.trim() || !workflowId, onClick: () => this.submit() }, '创建并启动'),
							),
						),
					),
				);
			}
			async submit() {
				const { description, title, storyCode, workflowId, cwd, inputs, model, provider } = this.state;
				const wf = this.selectedWorkflow();
				const wfInputs = (wf && Array.isArray(wf.inputs)) ? wf.inputs : [];
				this.setState({ busy: true });
				try {
					const body = { title: title.trim() || description.trim().slice(0, 50), workflowId };
					body.description = description.trim();
					if (storyCode.trim()) body.storyCode = storyCode.trim();
					if (cwd.trim()) body.cwd = cwd.trim();
					// 模型配置：填了就固定用（所有阶段 subagent），空则继承当前会话
					if (model.trim()) body.model = model.trim();
					if (provider.trim()) body.provider = provider.trim();
					const filled = {};
					wfInputs.forEach((inp) => { const v = inputs[inp.name]; if (v != null && v !== '') filled[inp.name] = v; });
					if (Object.keys(filled).length) body.inputs = filled;
					await api('/tasks', { method: 'POST', body });
					toast('任务已创建并启动');
					this.props.onClose();
					openDevBoard();
				} catch (e) { toast('创建失败：' + e.message); }
				this.setState({ busy: false });
			}
		}

		/** 中央「开发任务」页签内容：子 tab 切「任务 / 工作流」，铺满主区 */
		class WorkbenchView extends react.Component {
			constructor(props) {
				super(props);
				this.state = { tab: 'tasks' };
			}
			render() {
				const { tab } = this.state;
				return react.createElement('div', { className: 'knj-workbench' },
					react.createElement('div', { className: 'knj-wb-head' },
						react.createElement('div', { className: 'knj-wb-tabs' },
							react.createElement('button', { className: 'knj-wb-tab' + (tab === 'tasks' ? ' on' : ''), onClick: () => this.setState({ tab: 'tasks' }) }, '任务'),
							react.createElement('button', { className: 'knj-wb-tab' + (tab === 'workflows' ? ' on' : ''), onClick: () => this.setState({ tab: 'workflows' }) }, '工作流'),
						),
					),
					tab === 'tasks'
						? react.createElement(SidebarTasksTab, {})
						: react.createElement(SidebarWorkflowsTab, {}),
				);
			}
		}

		let devBoardRoot = null;
		let devBoardRootHandle = null; // React root 句柄（关闭时需 unmount 清定时器，不能只 remove DOM）
		let _closeDevBoard = null; // 收起开发任务弹窗（跳转子会话前先收起，避免盖住）
		function openDevBoard() {
			ensureStyle();
			if (devBoardRoot) { devBoardRoot.style.display = 'flex'; return; }
			devBoardRoot = document.createElement('div');
			document.body.appendChild(devBoardRoot);
			_closeDevBoard = () => {
				if (!devBoardRoot && !devBoardRootHandle) return;
				// 真正卸载而不是 display:none：否则再次打开会残留上次的详情视图/翻页/滚动位置
				if (devBoardRootHandle) { devBoardRootHandle.unmount(); devBoardRootHandle = null; }
				if (devBoardRoot) { devBoardRoot.remove(); devBoardRoot = null; }
			};
			devBoardRootHandle = react_dom_client.createRoot(devBoardRoot);
			devBoardRootHandle.render(react.createElement(DevBoardOverlay, {
				onClose: _closeDevBoard,
			}));
		}

		class DevBoardOverlay extends react.Component {
			render() {
				return react.createElement('div', { className: 'knj-overlay' },
					react.createElement('div', { className: 'knj-panel', style: { width: 'min(1680px, 97vw)', height: '93vh', maxHeight: '93vh' } },
						react.createElement('div', { className: 'knj-head' },
							react.createElement('h2', null, '开发任务'),
							react.createElement('button', { className: 'knj-close', onClick: this.props.onClose }, '关闭'),
						),
						react.createElement('div', { className: 'knj-body', style: { padding: 0 } },
							react.createElement(WorkbenchView, {}),
						),
					),
				);
			}
		}

		const inject = ['slots'];
		function apply(ctx) {
			const slots = ctx.get('slots');
			if (!slots) return;
			_sessions = ctx.get('sessions') || null; // 注入 sessions 服务，供「执行记录」跳转
			_workspaces = ctx.get('workspaces') || null; // 注入 workspaces 服务，供「新建任务」工作目录下拉
			_ctx = ctx;
			ensureStyle(); // 中央页签与模态共用样式，注册前先注入

			// 1) 菜单项注册到 knj.menu.item（由 dsh-knj-menu 菜单管理器统一渲染成常驻/折叠 + 📌固定）
			// 用 slots.inject 等待 knj.menu.item 声明（跨插件加载顺序无关），再注册。
			slots.inject('knj.menu.item', () => slots.register(
				{ name: 'knj.menu.item', id: 'knj-new-task', label: '新建任务', order: 0, defaultPinned: true, locale: 'zh' },
				(props) => react.createElement('button', {
					className: 'knj-newtask',
					title: '新建开发任务（绑定工作流并启动）',
					onClick: () => openNewTaskModal(),
				},
					react.createElement('svg', { className: 'knj-ico', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
						react.createElement('path', { d: 'M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z', fill: 'currentColor' }),
					),
					react.createElement('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden' } }, '新建任务'),
				)));
			slots.inject('knj.menu.item', () => slots.register(
				{ name: 'knj.menu.item', id: 'knj-dev-board', label: '开发任务', order: 10, defaultPinned: false, locale: 'zh' },
				(props) => react.createElement('button', {
					className: 'knj-newtask',
					title: '打开开发任务看板',
					onClick: () => openDevBoard(),
				},
					icon('list'),
					react.createElement('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden' } }, '开发任务'),
				)));

			// 「开发任务」已迁移到左侧工具栏入口 + overlay 看板（见 knj-dev-board / openDevBoard），
			// 不再注册 conversation.view 页签。
		}

		/** 「开发任务」页签：任务列表（卡片 + 分页 + 进度） */
		class SidebarTasksTab extends react.Component {
			constructor(props) {
				super(props);
				this.state = { tasks: [], error: null, detail: null, page: 1 };
			}
			componentDidMount() { this.refresh(); this._timer = setInterval(() => this.refresh(), 3000); }
			componentWillUnmount() { clearInterval(this._timer); }
			async refresh() {
				try {
					const t = await api('/tasks');
					this.setState({ tasks: t.tasks || [], error: null });
				} catch (e) { this.setState({ error: e.message }); }
			}
			stageInfo(t) {
				const steps = t.stageStates || [];
				const relevant = steps.filter((s) => s.status !== 'skipped');
				const done = relevant.filter((s) => s.status === 'done').length;
				const skipped = steps.length - relevant.length;
				if (t.status === 'success') return `已完成 · ${done}/${relevant.length} 阶段${skipped ? `（跳过 ${skipped}）` : ''}`;
				if (t.status === 'failed' || t.status === 'cancelled') return `${t.currentStage ? '失败于「' + t.currentStage + '」' : '已中断'} · ${done}/${relevant.length} 阶段`;
				if (t.status === 'waiting-human') return `待人工处理 · ${done}/${relevant.length} 阶段`;
				if (t.currentStage) return `阶段 ${Math.min(done + 1, relevant.length)}/${relevant.length} · ${t.currentStage}`;
				return `共 ${relevant.length} 个阶段`;
			}
			render() {
				const { tasks, error, detail } = this.state;
				if (detail) {
					return react.createElement(SidebarTaskDetail, {
						task: detail,
						onBack: () => this.setState({ detail: null }),
						onChanged: async () => { await this.refresh(); this.loadDetail(detail.id); },
					});
				}
				const PAGE_SIZE = 8;
				const totalPages = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE));
				const page = Math.min(this.state.page, totalPages);
				const pageTasks = tasks.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
				return react.createElement('div', null,
					error ? react.createElement('div', { className: 'knj-err' }, '加载失败：' + error) : null,
					react.createElement('div', { className: 'knj-row', style: { justifyContent: 'space-between', marginBottom: 14 } },
						react.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, `共 ${tasks.length} 个任务`),
						react.createElement('div', { className: 'knj-row', style: { gap: 8 } },
							react.createElement('button', { className: 'knj-btn', title: '刷新', onClick: () => this.refresh() }, icon('refresh'), '刷新'),
							react.createElement('button', { className: 'knj-btn primary', onClick: () => openNewTaskModal() }, icon('plus'), '新建任务'),
						),
					),
					tasks.length === 0
						? react.createElement('div', { className: 'knj-empty' }, '暂无任务，点击右上角「新建任务」开始')
						: pageTasks.map((t) => react.createElement('div', { key: t.id, className: 'knj-item-card' },
							react.createElement('div', { className: 'knj-item-head' },
								react.createElement('div', { className: 'knj-item-title', onClick: () => this.loadDetail(t.id) }, t.title),
								react.createElement('div', { className: 'knj-row', style: { gap: 6 } },
									react.createElement('span', { className: 'knj-badge', style: { background: (STATUS_META[t.status] || STATUS_META.pending).color } }, (STATUS_META[t.status] || STATUS_META.pending).label),
									react.createElement('button', { className: 'knj-btn', style: { padding: '0 8px', height: 26, fontSize: 12 }, title: '删除任务', onClick: (e) => { e.stopPropagation(); this.deleteTask(t.id); } }, icon('x')),
								),
							),
							react.createElement('div', { className: 'knj-item-stage' }, this.stageInfo(t)),
							react.createElement('div', { className: 'knj-item-foot' },
								react.createElement('div', { className: 'knj-progress' }, react.createElement('div', { style: { width: progressPct(t) + '%' } })),
								react.createElement('span', { className: 'knj-item-pct' }, `${progressPct(t)}%`),
							),
						)),
					totalPages > 1 ? react.createElement('div', { className: 'knj-pager' },
						react.createElement('button', { disabled: page <= 1, onClick: () => this.setState({ page: page - 1 }) }, '‹'),
						react.createElement('span', { className: 'pg' }, `${page} / ${totalPages}`),
						react.createElement('button', { disabled: page >= totalPages, onClick: () => this.setState({ page: page + 1 }) }, '›'),
					) : null,
				);
			}
			async deleteTask(id) {
				if (!window.confirm('确定删除该任务？其执行记录与产物将一并删除，不可恢复。')) return;
				try {
					await api('/tasks/' + id, { method: 'DELETE' });
					toast('任务已删除');
					this.refresh();
				} catch (e) { toast(e.message); }
			}
			async loadDetail(id) {
				try { const { task } = await api('/tasks/' + id); this.setState({ detail: task }); }
				catch (e) { toast(e.message); }
			}
		}

		/** 右侧栏「工作流」tab：模板列表 + 编辑（复用 GraphEditor） */
		class SidebarWorkflowsTab extends react.Component {
			constructor(props) {
				super(props);
				this.state = { workflows: [], error: null, editing: null, page: 1 };
			}
			componentDidMount() { this.refresh(); }
			async refresh() {
				try {
					const w = await api('/workflows');
					this.setState({ workflows: w.workflows || [], error: null });
				} catch (e) { this.setState({ error: e.message }); }
			}
			render() {
				const { workflows, error, editing, page } = this.state;
				const PAGE_SIZE = 8;
				const totalPages = Math.max(1, Math.ceil((workflows || []).length / PAGE_SIZE));
				const curPage = Math.min(page || 1, totalPages);
				const pageWorkflows = (workflows || []).slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);
				if (editing) {
					return react.createElement(GraphEditor, {
						workflow: editing,
						onBack: () => this.setState({ editing: null }),
						onSaved: async () => { await this.refresh(); this.setState({ editing: null }); },
					});
				}
				return react.createElement('div', null,
					error ? react.createElement('div', { className: 'knj-err' }, '加载失败：' + error) : null,
					react.createElement('div', { className: 'knj-row', style: { justifyContent: 'space-between', marginBottom: 14 } },
						react.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, `共 ${workflows.length} 个工作流`),
						react.createElement('button', { className: 'knj-btn primary', onClick: () => {
							this.setState({ editing: { id: 'wf-' + Date.now().toString(36), name: '', description: '', schemaVersion: 2, inputs: [], nodes: [{ id: 'start', type: 'start' }, { id: 'end', type: 'end' }], edges: [] } });
						} }, icon('plus'), '新建工作流'),
					),
					(workflows || []).length === 0
						? react.createElement('div', { className: 'knj-empty' }, '暂无工作流，点击右上角「新建工作流」')
						: pageWorkflows.map((w) => react.createElement('div', { key: w.id, className: 'knj-item-card' },
							react.createElement('div', { className: 'knj-item-head' },
								react.createElement('div', { className: 'knj-item-title' }, w.name),
								react.createElement('div', { className: 'knj-row', style: { gap: 6 } },
									react.createElement('button', { className: 'knj-btn', onClick: () => this.setState({ editing: w }) }, '编辑'),
									react.createElement('button', { className: 'knj-btn danger', onClick: async () => {
										if (!window.confirm('确定删除工作流「' + w.name + '」？已有任务不受影响（使用快照）。')) return;
										try { await api('/workflows/' + w.id, { method: 'DELETE' }); this.refresh(); } catch (e) { toast(e.message); }
									} }, '删除'),
								),
							),
							react.createElement('div', { className: 'knj-item-stage' }, `${w.id} · ${(w.nodes || []).filter((n) => n.type === 'task').length} 个阶段${w.description ? ' · ' + w.description : ''}`),
						)),
					totalPages > 1 ? react.createElement('div', { className: 'knj-pager' },
						react.createElement('button', { disabled: curPage <= 1, onClick: () => this.setState({ page: curPage - 1 }) }, '‹'),
						react.createElement('span', { className: 'pg' }, `${curPage} / ${totalPages}`),
						react.createElement('button', { disabled: curPage >= totalPages, onClick: () => this.setState({ page: curPage + 1 }) }, '›'),
					) : null,
				);
			}
		}

		/** 右侧栏任务详情（横向步骤条 + 重跑/继续），复用 TaskDetail 渲染逻辑 */
		class SidebarTaskDetail extends react.Component {
			constructor(props) {
				super(props);
				this.state = { results: null, rejectFeedback: '', expanded: null, fileView: null };
			}
			componentDidMount() { this.loadResults(); this.preloadCatalog(); }
			/** 预加载 parent 的子会话 catalog：让「查看」点击时直接 open、无需每次 await 慢 RPC */
			async preloadCatalog() {
				const { task } = this.props;
				if (!_sessions || !task.parentSessionId) return;
				try { await _sessions.refreshSubagents(task.parentSessionId); } catch {}
			}
			async loadResults() {
				try {
					const r = await api('/tasks/' + this.props.task.id + '/results');
					this.setState({ results: r.results });
				} catch { this.setState({ results: null }); }
			}
			/** 刷新详情：重新拉产物 + 让父级重取任务数据 */
			async refresh() {
				await this.loadResults();
				if (this.props.onChanged) this.props.onChanged();
			}
			/** 某节点的产物（results.json 里按节点 id 存；展开时若缺失会从 stage 文件补，见 toggle） */
			resultFor(stageId) {
				const results = this.state.results;
				if (!results || typeof results !== 'object') return null;
				return results[stageId] ?? null;
			}
			async toggle(stageId) {
				const willExpand = this.state.expanded !== stageId;
				this.setState((s) => ({ expanded: willExpand ? stageId : null }));
				// 展开时补产物：results.json 可能为空（任务中断/未 finalize），
				// 但每节点完成时 checkpoint 会实时落盘 stages/<id>.json——从那里补。
				if (!willExpand) return;
				if (this.resultFor(stageId) != null) return;
				try {
					const r = await api('/tasks/' + this.props.task.id + '/stages/' + stageId);
					if (r && r.data != null && typeof r.data === 'object') {
						this.setState((s) => ({ results: { ...(s.results || {}), [stageId]: r.data } }));
					}
				} catch { /* stage 文件也没有则保持无产物 */ }
			}
			duration(s) {
				if (!s.startedAt || !s.finishedAt) return '';
				const ms = new Date(s.finishedAt) - new Date(s.startedAt);
				if (ms < 0) return '';
				const sec = Math.round(ms / 1000);
				if (sec < 60) return `${sec}s`;
				const m = Math.floor(sec / 60), r = sec % 60;
				return `${m}m${r}s`;
			}
			/** 流程节点卡片：状态圆点 + 标题 + 耗时，点击展开产物与执行记录（整合，不再平铺三个区块） */
			renderNodeCard(s, i) {
				const meta = STAGE_META[s.status] || STAGE_META.pending;
				const isRunning = s.status === 'running';
				const dur = this.duration(s);
				const result = this.resultFor(s.id);
				const sessionIds = s.sessionIds || [];
				const expanded = this.state.expanded === s.id;
				// 展开条件放宽：done/failed 节点必有产物（可能在 results 里或 stage 文件里），点了再异步补数据
				const hasDetail = result != null || sessionIds.length > 0 || s.error || s.status === 'done' || s.status === 'failed';
				const statusIcon = s.status === 'done' ? icon('check')
					: isRunning ? icon('clock')
					: s.status === 'skipped' ? '–'
					: s.status === 'failed' ? icon('x')
					: (i + 1);
				return react.createElement('div', { key: s.id, className: 'knj-node-card' },
					react.createElement('div', { className: 'knj-node-head', onClick: () => hasDetail && this.toggle(s.id) },
						react.createElement('div', { className: 'knj-node-dot', style: { background: meta.color, ...(isRunning ? { boxShadow: '0 0 0 4px rgba(37,99,235,.2)' } : {}) } }, statusIcon),
						react.createElement('div', { style: { flex: 1, minWidth: 0 } },
							react.createElement('div', { className: 'knj-node-title' }, s.title),
							react.createElement('div', { className: 'knj-node-sub' }, dur ? `${dur} · ${meta.label}` : meta.label),
						),
						s.status === 'failed'
							? react.createElement('button', { className: 'knj-btn danger', style: { flexShrink: 0 }, onClick: (e) => { e.stopPropagation(); this.rerunStage(s.id); } }, '重跑')
							: null,
						hasDetail ? react.createElement('span', { style: { flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)', display: 'inline-flex' } }, icon(expanded ? 'chevron-down' : 'chevron-right')) : null,
					),
					expanded ? react.createElement('div', { className: 'knj-node-body' },
						s.error ? react.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-all' } }, s.error) : null,
						result != null ? react.createElement('div', null,
							react.createElement('div', { className: 'knj-node-sec' }, '产物（输出字段）'),
							this.renderResultFields(result),
							this.renderFiles(s.id, result),
						) : null,
						this.state.fileView && this.state.fileView.stageId === s.id ? react.createElement('div', null,
							react.createElement('div', { className: 'knj-node-sec', style: { display: 'flex', alignItems: 'center', gap: 8 } },
								react.createElement('span', null, '文件内容'),
								react.createElement('span', { style: { fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, this.state.fileView.path),
							),
							react.createElement('pre', { style: { maxHeight: 320 } }, this.state.fileView.content),
						) : null,
						sessionIds.length > 0 ? react.createElement('div', null,
							react.createElement('div', { className: 'knj-node-sec' }, '执行记录（子会话）'),
							sessionIds.map((sid) => react.createElement('div', { key: sid, className: 'knj-row', style: { marginTop: 6, gap: 8 } },
								react.createElement('code', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', flex: 1, wordBreak: 'break-all' } }, '👤 ' + sid),
								react.createElement('button', { className: 'knj-btn', style: { flexShrink: 0 }, title: '跳转到该子代理会话查看完整执行细节', onClick: () => this.viewSubagent(sid) }, '查看会话'),
							)),
						) : null,
					) : null,
				);
			}
			/** 节点输出按字段展示：字段名（灰底标签）+ 值（缩进 + 左边框竖线），对象/数组折叠为 JSON */
			renderResultFields(result) {
				if (result && typeof result === 'object' && !Array.isArray(result)) {
					const keys = Object.keys(result);
					if (keys.length === 0) return react.createElement('pre', { style: { fontSize: 11 } }, '{}');
					const labelStyle = { display: 'inline-block', background: 'var(--dsw-alias-fill-2, #eef0f3)', padding: '1px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, fontFamily: 'monospace', color: 'var(--dsw-alias-label-secondary)' };
					const valueStyle = { fontSize: 12.5, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all', whiteSpace: 'pre-wrap', marginTop: 4, paddingLeft: 10, borderLeft: '2px solid var(--dsw-alias-border-l2, #e2e6ec)' };
					return react.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
						keys.map((k) => {
							const v = result[k];
							const simple = v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
							return react.createElement('div', { key: k },
								react.createElement('div', { style: labelStyle }, k),
								simple
									? react.createElement('div', { style: valueStyle }, v == null ? String(v) : String(v))
									: react.createElement('pre', { style: { ...valueStyle, fontSize: 11, maxHeight: 160, overflow: 'auto', background: 'var(--dsw-alias-fill-2, #f5f6f8)', padding: 6, borderRadius: 4, marginLeft: 10, borderLeft: '2px solid var(--dsw-alias-border-l2, #e2e6ec)' } }, JSON.stringify(v, null, 2)),
							);
						}),
					);
				}
				// 数组/标量等非对象结果：保持 JSON 展示
				return react.createElement('pre', { style: { fontSize: 11 } }, JSON.stringify(result, null, 2));
			}
			/** 从产物里识别文件路径并渲染为可点击的「查看文件」列表 */
			renderFiles(stageId, result) {
				const files = [...collectFiles(result)];
				if (!files.length) return null;
				return react.createElement('div', null,
					react.createElement('div', { className: 'knj-node-sec' }, '文件（产物路径）'),
					files.map((f) => react.createElement('div', { key: f, className: 'knj-row', style: { marginTop: 6, gap: 8 } },
						react.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: f }, '📄 ' + f),
						react.createElement('button', { className: 'knj-btn', style: { flexShrink: 0, borderColor: 'var(--dsw-static-blue-600)', color: 'var(--dsw-static-blue-600)' }, title: '读取并查看该文件内容', onClick: () => this.viewFile(stageId, f) }, '查看文件'),
					)),
				);
			}
			/** 读取并展示任务工作目录下的文件内容（相对 cwd 解析，Host 端限制在 cwd 内） */
			async viewFile(stageId, path) {
				const { task } = this.props;
				try {
					const r = await api('/tasks/' + task.id + '/file?path=' + encodeURIComponent(path));
					this.setState({ fileView: { stageId, path: r.path, content: r.content } });
				} catch (e) { toast('读取失败：' + e.message); }
			}
			renderHumanCard(task) {
				const humanNode = (task.workflowSnapshot?.nodes || []).find((n) => n.id === task.humanState?.humanId);
				const routes = humanRoutes(humanNode);
				const displayFrom = humanNode?.displayFrom;
				const results = this.state.results || task.humanState?.results || {};
				const display = displayFrom ? results[displayFrom] : null;
				const btnStyle = (route) => {
					const map = { success: 'var(--dsw-static-green-500)', danger: 'var(--dsw-static-red-500)', warning: 'var(--dsw-static-amber-500)', info: 'var(--dsw-static-blue-600)', neutral: 'var(--dsw-alias-label-secondary)' };
					const c = map[route.tone] || map.info;
					return { flex: 1, borderColor: c, color: c };
				};
				return react.createElement('div', { className: 'knj-card', style: { flexDirection: 'column', alignItems: 'stretch', borderColor: '#7c5cff', background: '#f4f1ff', marginBottom: 12 } },
					react.createElement('div', { className: 'knj-row' },
						react.createElement('span', { style: { fontWeight: 600, color: '#7c5cff', fontSize: 13 } }, '等待人工处理'),
						react.createElement('span', { className: 'knj-badge', style: { background: '#7c5cff' } }, '待审批'),
					),
					react.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 8, lineHeight: 1.6 } }, routes.length > 0 ? '任务已运行到人工审批节点。选择一个去向继续（可附意见）。' : '任务已运行到人工审批节点（未配置去向）。'),
					display
						? react.createElement('pre', { style: { fontSize: 12, lineHeight: 1.5, overflow: 'auto', maxHeight: 200, margin: '8px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)', background: '#fff', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 10 } }, JSON.stringify(display, null, 2))
						: react.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginTop: 8 } }, '（未配置展示产物或产物为空）'),
					react.createElement('textarea', { className: 'knj-textarea', style: { minHeight: 56, marginTop: 10 }, placeholder: '意见（可选，去向目标节点会看到）', value: this.state.rejectFeedback, onChange: (e) => this.setState({ rejectFeedback: e.target.value }) }),
					react.createElement('div', { className: 'knj-row', style: { marginTop: 12, gap: 10 } },
						routes.map((route) => react.createElement('button', { key: route.label + ':' + route.to, className: 'knj-btn', style: btnStyle(route), onClick: () => this.decide(route.label) }, route.label || '（未命名去向）')),
					),
				);
			}
			render() {
				const { task, onBack } = this.props;
				const steps = task.stageStates || [];
				const pct = progressPct(task);
				const statusMeta = STATUS_META[task.status] || STATUS_META.pending;
				const relevant = steps.filter((s) => s.status !== 'skipped');
				const doneCount = relevant.filter((s) => s.status === 'done').length;
				return react.createElement('div', { style: { padding: 12 } },
					// 头部：返回 + 标题 + 刷新 + 状态
					react.createElement('div', { className: 'knj-row' },
						react.createElement('button', { className: 'knj-btn', onClick: onBack }, '←'),
						react.createElement('div', { style: { flex: 1, minWidth: 0 } },
							react.createElement('div', { className: 'title', style: { fontSize: 14, fontWeight: 600 } }, task.title),
							react.createElement('div', { className: 'sub' }, task.id),
						),
						react.createElement('button', { className: 'knj-btn', title: '刷新', onClick: () => this.refresh() }, icon('refresh'), '刷新'),
						react.createElement('span', { className: 'knj-badge', style: { background: statusMeta.color } }, statusMeta.label),
						task.model ? react.createElement('span', { className: 'knj-badge', style: { background: '#5b6472' }, title: '该任务固定的执行模型（创建时指定）' }, task.model) : null,
					),
					// 整体进度条 + 摘要
					react.createElement('div', { className: 'knj-progress', style: { width: '100%', marginTop: 12 } },
						react.createElement('div', { style: { width: pct + '%' } }),
					),
					react.createElement('div', { className: 'sub', style: { marginTop: 4 } }, `进度 ${pct}% · 完成 ${doneCount}/${relevant.length} 阶段${steps.length - relevant.length ? `（跳过 ${steps.length - relevant.length}）` : ''}`),
					// 人工审批卡片
					task.status === 'waiting-human' ? this.renderHumanCard(task) : null,
					// 流程节点卡片（纵向，一眼看全局；点击节点展开产物/执行记录）
					react.createElement('div', { className: 'knj-form-section', style: { marginTop: 12 } },
						react.createElement('div', { className: 'knj-form-label' }, `流程进度（${steps.length}）`),
						steps.map((s, i) => this.renderNodeCard(s, i)),
					),
					// 操作按钮
					task.status === 'pending'
						? react.createElement('div', { className: 'knj-row' },
							react.createElement('button', { className: 'knj-btn primary', onClick: () => this.startTask() }, icon('play'), '启动'),
						)
						: task.status === 'running'
							? react.createElement('div', { className: 'knj-row' },
								react.createElement('button', { className: 'knj-btn danger', onClick: () => this.cancelTask() }, icon('x'), '取消'),
							)
							: (task.status === 'failed' || task.status === 'cancelled')
								? react.createElement('div', { className: 'knj-row', style: { gap: 8 } },
									react.createElement('button', { className: 'knj-btn primary', style: { flex: 1 }, title: '从断点继续（跳过已完成节点）', onClick: () => this.resume('resume') }, icon('play'), '续跑'),
									react.createElement('button', { className: 'knj-btn', style: { flex: 1 }, title: '从头重新执行所有节点', onClick: () => this.resume('rerun') }, icon('repeat'), '重跑'),
								)
								: null,
					task.error ? react.createElement('div', { className: 'knj-err' }, '错误：' + task.error) : null,
				);
			}
			/** 把某个节点 subagent 会话跳回 DSH 原生会话查看（只读查看执行细节） */
			async viewSubagent(childId) {
				if (!_sessions) { toast('sessions 服务不可用'); return; }
				try {
					// 先收起开发任务弹窗，再跳子会话，避免弹窗盖住子会话
					_closeDevBoard?.();
					// catalog 已在 preloadCatalog 后台加载，这里直接 open（select 内部会 navigationAddress 解析）。
					// 若 catalog 尚未就绪导致 open 抛错，回退刷新一次再跳。
					try {
						_sessions.open(childId);
					} catch (firstError) {
						const { task } = this.props;
						if (task.parentSessionId) await _sessions.refreshSubagents(task.parentSessionId);
						_sessions.open(childId);
					}
				} catch (e) { toast('跳转失败：' + (e && e.message ? e.message : e)); }
			}
			async decide(decision) {
				try {
					const feedback = (this.state.rejectFeedback || '').trim();
					await api('/tasks/' + this.props.task.id + '/decide', { method: 'POST', body: { decision, ...(feedback ? { feedback } : {}) } });
					toast('已选择：' + decision);
					setTimeout(() => this.props.onChanged(), 500);
				} catch (e) { toast(e.message); }
			}
			async rerunStage(stageId) {
				try {
					await api('/tasks/' + this.props.task.id + '/rerun-stage', { method: 'POST', body: { stageId } });
					toast('已重跑阶段：' + stageId);
					setTimeout(() => this.props.onChanged(), 500);
				} catch (e) { toast(e.message); }
			}
			async resume(mode = 'resume') {
				try {
					await api('/tasks/' + this.props.task.id + '/resume', { method: 'POST', body: { mode } });
					toast(mode === 'rerun' ? '任务已从头重跑' : '任务已从断点继续');
					setTimeout(() => this.props.onChanged(), 500);
				} catch (e) { toast(e.message); }
			}
			async startTask() {
				try {
					await api('/tasks/' + this.props.task.id + '/start', { method: 'POST', body: {} });
					toast('任务已启动');
					setTimeout(() => this.props.onChanged(), 500);
				} catch (e) { toast(e.message); }
			}
			async cancelTask() {
				try {
					await api('/tasks/' + this.props.task.id + '/cancel', { method: 'POST', body: {} });
					toast('已请求取消');
					setTimeout(() => this.props.onChanged(), 500);
				} catch (e) { toast(e.message); }
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
