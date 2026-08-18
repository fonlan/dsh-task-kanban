window.__ModuleLoader__.load({
	id: "@fonlan/dsh-task-kanban",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region src/shared/lanes.ts
		/** Which lane a card renders in, based on status + error stage. */
		function laneOf(card) {
			if (card.status === "error") {
				if (card.error?.stage !== void 0) return card.error.stage;
				const kind = card.error?.kind;
				if (kind === "phase_failed" || kind === "no_base_branch" || kind === "worktree_failed") return "running";
				if (kind === "merge_failed") return "completed";
				return "demand";
			}
			switch (card.status) {
				case "draft":
				case "refining":
				case "planned": return "demand";
				case "queued": return "queue";
				case "running": return "running";
				case "completed":
				case "merging": return "completed";
				case "merged": return "merged";
			}
		}
		/** Lanes a drop onto `to` may come from. */
		const DROP_RULES = {
			demand: ["queue"],
			queue: ["demand", "running"],
			running: [],
			completed: [],
			merged: []
		};
		//#endregion
		//#region src/client/api.ts
		var KanbanApiError = class extends Error {
			code;
			constructor(code, message) {
				super(message);
				this.code = code;
			}
		};
		async function call(method, payload = {}) {
			let response;
			try {
				response = await fetch(`/plugins/@fonlan/dsh-task-kanban/api/${method}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload)
				});
			} catch (error) {
				throw new KanbanApiError("network", error instanceof Error ? error.message : String(error));
			}
			const parsed = await response.json().catch(() => null);
			if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === void 0) throw new KanbanApiError(parsed?.error?.code ?? "http", parsed?.error?.message ?? `HTTP ${response.status}`);
			return parsed.value;
		}
		/**
		* Call the host gateway's `skill.list` unary RPC over the same-origin HTTP
		* bridge (the exact wire shape DSH's chat input uses for its /-autocomplete).
		* The requested `sessionId` scopes the catalog to that session's agent
		* preset, which is where the filesystem skill roots are registered.
		*/
		async function gatewaySkillList(sessionId) {
			let response;
			try {
				response = await fetch("/api/skill.list", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						type: "client-request",
						rpcId: `task-kanban-${Math.random().toString(36).slice(2)}`,
						method: "skill.list",
						payload: { sessionId }
					})
				});
			} catch (error) {
				throw new KanbanApiError("network", error instanceof Error ? error.message : String(error));
			}
			const parsed = await response.json().catch(() => null);
			if (!response.ok || parsed === null || parsed.type !== "server-response" || parsed.result?.ok !== true) throw new KanbanApiError(parsed?.result?.error?.code ?? "http", parsed?.result?.error?.message ?? `HTTP ${response.status}`);
			return parsed.result.value?.skills ?? [];
		}
		const api = {
			list: (workspacePath) => call("list", { workspacePath }),
			create: (workspacePath, requirement, model, provider, skill) => call("create", {
				workspacePath,
				requirement,
				model,
				provider,
				...skill !== void 0 && skill !== "" ? { skill } : {}
			}),
			move: (cardId, toLane) => call("move", {
				cardId,
				toLane
			}),
			stop: (cardId) => call("stop", { cardId }),
			retry: (cardId) => call("retry", { cardId }),
			remove: (cardId) => call("remove", { cardId }),
			settingsGet: () => call("settings.get"),
			settingsSet: (patch) => call("settings.set", patch),
			models: () => call("models.list")
		};
		//#endregion
		//#region src/client/kanban-state.ts
		/**
		* HMR-safe shared state store keyed on the global symbol registry.
		*
		* The client-hmr hot swap re-evaluates this module (a fresh `lib/client.js`
		* bundle) WITHOUT reloading the page. A module-level singleton would then be
		* duplicated per evaluation: the session-navigation wrapper installed by the
		* OLD module copy keeps calling the OLD copy's `exitBoard`, which reads the
		* OLD copy's `boardOpen`/`boardDisposer` — while a board opened after the swap
		* writes the NEW copy's state cell. The wrapper would then no-op and clicking
		* a sidebar session would never leave the board.
		*
		* Keeping every field on one `globalThis`-backed record (via `Symbol.for`, so
		* all bundle copies resolve the same key) makes every copy read/write the same
		* state cell, so exit works regardless of which module copy performed the
		* enter.
		*/
		const STATE_KEY = Symbol.for("@fonlan/dsh-task-kanban/state");
		function getState() {
			const g = globalThis;
			let state = g[STATE_KEY];
			if (state === void 0) {
				state = {
					client: null,
					boardRoot: null,
					boardDisposer: null,
					boardOpen: false,
					listeners: /* @__PURE__ */ new Set()
				};
				g[STATE_KEY] = state;
			}
			return state;
		}
		function setClient(ctx) {
			getState().client = ctx;
		}
		function getClient() {
			return getState().client;
		}
		function setBoardRoot(component) {
			getState().boardRoot = component;
		}
		function notify() {
			for (const listener of getState().listeners) listener();
		}
		function isBoardOpen() {
			return getState().boardOpen;
		}
		function subscribe(cb) {
			const listeners = getState().listeners;
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		}
		function useBoardOpen() {
			return (0, react.useSyncExternalStore)(subscribe, isBoardOpen);
		}
		function enterBoard() {
			const state = getState();
			const ctx = state.client;
			const root = state.boardRoot;
			if (ctx === null || root === null || state.boardDisposer !== null) return;
			try {
				state.boardDisposer = ctx.slots.register({
					name: "conversation",
					priority: -1,
					locale: "task-kanban"
				}, root);
				state.boardOpen = true;
				notify();
			} catch (error) {
				console.error("[@fonlan/dsh-task-kanban] cannot open the board:", error);
			}
		}
		function exitBoard() {
			const state = getState();
			if (state.boardDisposer !== null) {
				state.boardDisposer();
				state.boardDisposer = null;
			}
			if (state.boardOpen) {
				state.boardOpen = false;
				notify();
			}
		}
		function toggleBoard() {
			if (isBoardOpen()) exitBoard();
			else enterBoard();
		}
		/**
		* Route session navigation through the board: opening any session while the
		* board is open leaves the board first, so the conversation view can render
		* for the newly selected session.
		*
		* Every sidebar path that selects a session funnels through `sessions.open`
		* (session rows, search results, fork results, New Session) or
		* `sessions.openSubagent` (catalog children) — including re-clicking the
		* already-current session, which never changes `list.current` and therefore
		* cannot be caught by a list-store subscription. Wrapping the two entry
		* points covers all of them in one place.
		*
		* The wrapper is idempotent: a `kbBound` marker on the wrapper prevents a
		* second bind (plugin re-apply / HMR) from stacking another layer. Because the
		* wrapper's exit goes through the shared state store, a wrapper left over from
		* a previous (HMR-replaced) module copy still closes the board correctly.
		*/
		function bindSessionNavigation(ctx) {
			const sessions = ctx.sessions;
			if (sessions === void 0) return;
			const open = sessions.open;
			if (typeof open === "function" && open.kbBound !== true) {
				const bound = ((id) => {
					exitBoard();
					return open.call(sessions, id);
				});
				bound.kbBound = true;
				sessions.open = bound;
			}
			const openSubagent = sessions.openSubagent;
			if (typeof openSubagent === "function" && openSubagent.kbBound !== true) {
				const bound = ((address) => {
					exitBoard();
					return openSubagent.call(sessions, address);
				});
				bound.kbBound = true;
				sessions.openSubagent = bound;
			}
		}
		//#endregion
		//#region src/client/locales.ts
		const LOCALE_NS = "task-kanban";
		const zh = {
			kanban: "任务看板",
			openBoard: "打开任务看板",
			closeBoard: "返回对话",
			newTask: "新建任务",
			requirement: "需求",
			project: "所属项目",
			model: "模型",
			cancel: "取消",
			close: "关闭",
			addAndRefine: "添加并细化",
			laneDemand: "需求",
			laneQueue: "队列",
			laneRunning: "运行中",
			laneCompleted: "已完成",
			laneMerged: "已合并",
			statusDraft: "未细化",
			statusRefining: "细化中",
			statusPlanned: "已规划",
			statusQueued: "排队中",
			statusRunning: "实现中",
			statusCompleted: "已完成",
			statusMerging: "合并中",
			statusMerged: "已合并",
			statusError: "出错",
			phaseProgress: "{current}/{total}",
			retry: "重试",
			stop: "停止",
			delete: "删除",
			deleteConfirm: "确定删除该任务？其 worktree 会被清理。",
			openSession: "打开会话",
			plan: "实现方案",
			summary: "摘要",
			phases: "阶段",
			phaseGoal: "目标",
			phaseSessions: "会话",
			phaseConclusion: "结论",
			error: "错误",
			requirementLabel: "需求文本",
			requirementPlaceholder: "描述你要实现的需求……",
			skillGestureHint: "开头输入 /skill-name 可指定细化时使用的 Skill（如 /grill-me）",
			skillHint: "细化时将使用 Skill「{skill}」，并可与该会话交流打磨需求",
			skillMenuUserOnly: "仅用户可调",
			skillBadge: "细化 Skill：/{skill}",
			modelPlaceholder: "（使用默认模型）",
			noWorkspace: "没有可用工作区，请先在侧边栏添加",
			refresh: "刷新",
			settingsTitle: "任务看板",
			maxParallelWorkers: "全局并行 worker 数",
			defaultModel: "默认模型",
			saved: "已保存",
			loadError: "加载任务失败",
			noPlan: "该卡片还没有实现计划，请先点击\"添加并细化\"",
			dragNoPlan: "还没有实现计划的卡片不能进入队列",
			actionFailed: "操作失败：{message}",
			sessionNotListed: "该会话不在当前列表，可能来自其他工作区",
			interrupted: "已中断",
			noBaseBranch: "项目没有 main/master 分支",
			worktreeFailed: "worktree 创建失败",
			refineFailed: "细化失败",
			phaseFailed: "阶段执行失败",
			mergeFailed: "合并失败",
			createFailed: "创建失败",
			refinementLabel: "需求细化",
			mergeLabel: "合并",
			commitLabel: "提交"
		};
		const en = {
			kanban: "Task Kanban",
			openBoard: "Open Task Kanban",
			closeBoard: "Back to chat",
			newTask: "New Task",
			requirement: "Requirement",
			project: "Project",
			model: "Model",
			cancel: "Cancel",
			close: "Close",
			addAndRefine: "Add & Refine",
			laneDemand: "Demands",
			laneQueue: "Queue",
			laneRunning: "Running",
			laneCompleted: "Completed",
			laneMerged: "Merged",
			statusDraft: "Unrefined",
			statusRefining: "Refining",
			statusPlanned: "Planned",
			statusQueued: "Queued",
			statusRunning: "Running",
			statusCompleted: "Completed",
			statusMerging: "Merging",
			statusMerged: "Merged",
			statusError: "Error",
			phaseProgress: "{current}/{total}",
			retry: "Retry",
			stop: "Stop",
			delete: "Delete",
			deleteConfirm: "Delete this task? Its worktree will be cleaned up.",
			openSession: "Open session",
			plan: "Plan",
			summary: "Summary",
			phases: "Phases",
			phaseGoal: "Goal",
			phaseSessions: "Sessions",
			phaseConclusion: "Conclusion",
			error: "Error",
			requirementLabel: "Requirement",
			requirementPlaceholder: "Describe what you want to build…",
			skillGestureHint: "Start with /skill-name to choose the refinement skill (e.g. /grill-me)",
			skillHint: "Refinement will use Skill “{skill}” — talk to this session to refine the requirement",
			skillMenuUserOnly: "User-only",
			skillBadge: "Refine skill: /{skill}",
			modelPlaceholder: "(use default model)",
			noWorkspace: "No workspaces available — add one in the sidebar first",
			refresh: "Refresh",
			settingsTitle: "Task Kanban",
			maxParallelWorkers: "Global parallel workers",
			defaultModel: "Default model",
			saved: "Saved",
			loadError: "Failed to load tasks",
			noPlan: "This card has no plan yet — click \"Add & Refine\" first",
			dragNoPlan: "Cards without a plan cannot enter the queue",
			actionFailed: "Action failed: {message}",
			sessionNotListed: "Session is not listed here; it may belong to another workspace",
			interrupted: "Interrupted",
			noBaseBranch: "Project has no main/master branch",
			worktreeFailed: "Worktree creation failed",
			refineFailed: "Refinement failed",
			phaseFailed: "Phase failed",
			mergeFailed: "Merge failed",
			createFailed: "Creation failed",
			refinementLabel: "Refinement",
			mergeLabel: "Merge",
			commitLabel: "Commit"
		};
		//#endregion
		//#region \0dsh-css:/Users/fonlan/Repos/dsh-task-kanban/src/client/board.css.mjs
		const css = "/* @fonlan/dsh-task-kanban board styles (kb- prefixed, plain CSS).\n   Surfaces use the DSH theme tokens (--dsw-alias-*) so they follow the\n   shell's selected light/dark appearance; the var() fallbacks cover shells\n   that do not define them. */\n.kb-board {\n  height: 100%;\n  display: flex;\n  flex-direction: column;\n  box-sizing: border-box;\n  padding: 12px 16px;\n  overflow: hidden;\n  color: var(--dsw-alias-label-primary, var(--dsh-fg, #e6e6e6));\n  background: var(--dsw-alias-bg-base, var(--dsh-bg, #141418));\n  font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;\n}\n.kb-empty {\n  align-items: center;\n  justify-content: center;\n}\n.kb-empty-text { opacity: 0.6; }\n.kb-board-header {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  padding-bottom: 10px;\n  border-bottom: 1px solid rgba(128, 128, 128, 0.25);\n  flex: 0 0 auto;\n}\n/* Left-aligned group: workspace selector + new-task button sit adjacent. */\n.kb-board-title {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n  flex: 0 1 auto;\n}\n.kb-board-title .kb-btn { flex: none; }\n.kb-ws-select {\n  max-width: 320px;\n  min-width: 0;\n  flex: 0 1 auto;\n  padding: 6px 10px;\n  border-radius: 6px;\n  border: 1px solid rgba(128, 128, 128, 0.35);\n  background: rgba(128, 128, 128, 0.12);\n  color: inherit;\n  font-size: 14px;\n}\n.kb-btn {\n  padding: 6px 14px;\n  border-radius: 6px;\n  border: 1px solid rgba(128, 128, 128, 0.35);\n  background: rgba(128, 128, 128, 0.12);\n  color: inherit;\n  font-size: 13px;\n  white-space: nowrap;\n  cursor: pointer;\n}\n.kb-btn:hover { background: rgba(128, 128, 128, 0.22); }\n.kb-btn:disabled { opacity: 0.5; cursor: default; }\n.kb-btn-primary { background: #3b82f6; border-color: #3b82f6; color: #fff; }\n.kb-btn-primary:hover { background: #2f6fe0; }\n.kb-btn-danger { background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.5); color: #f87171; }\n.kb-btn-small { padding: 2px 8px; font-size: 12px; }\n.kb-lanes {\n  flex: 1 1 auto;\n  display: flex;\n  gap: 12px;\n  overflow-x: auto;\n  overflow-y: hidden;\n  padding-top: 10px;\n  min-height: 0;\n}\n.kb-lane {\n  flex: 1 1 0;\n  min-width: 220px;\n  max-width: 320px;\n  display: flex;\n  flex-direction: column;\n  background: rgba(128, 128, 128, 0.07);\n  border-radius: 8px;\n  border: 1px solid rgba(128, 128, 128, 0.12);\n  overflow: hidden;\n}\n.kb-lane-drop { border-style: dashed; border-color: rgba(59, 130, 246, 0.45); }\n.kb-lane-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  padding: 8px 10px;\n  font-weight: 600;\n  font-size: 13px;\n  color: var(--dsw-alias-label-secondary, var(--dsh-fg-soft, #b8b8c0));\n  border-bottom: 1px solid rgba(128, 128, 128, 0.12);\n  flex: 0 0 auto;\n}\n.kb-lane-count {\n  background: rgba(128, 128, 128, 0.18);\n  border-radius: 10px;\n  padding: 0 8px;\n  font-size: 12px;\n}\n.kb-lane-body {\n  flex: 1 1 auto;\n  overflow-y: auto;\n  padding: 8px;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n.kb-card {\n  background: rgba(128, 128, 128, 0.1);\n  border: 1px solid rgba(128, 128, 128, 0.2);\n  border-radius: 8px;\n  padding: 8px 10px;\n  cursor: pointer;\n  user-select: none;\n}\n.kb-card:hover { border-color: rgba(128, 128, 128, 0.45); }\n.kb-card[draggable='true'] { cursor: grab; }\n.kb-card-running { border-color: rgba(59, 130, 246, 0.6); }\n.kb-card-error { border-color: rgba(239, 68, 68, 0.6); }\n.kb-card-title { font-weight: 600; font-size: 13px; margin-bottom: 6px; word-break: break-all; }\n.kb-card-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12px; }\n.kb-card-badge {\n  background: rgba(128, 128, 128, 0.2);\n  border-radius: 4px;\n  padding: 1px 6px;\n}\n.kb-card-running .kb-card-badge { background: rgba(59, 130, 246, 0.3); }\n.kb-card-error .kb-card-badge { background: rgba(239, 68, 68, 0.3); }\n.kb-card-phase { opacity: 0.8; }\n.kb-card-skill {\n  background: rgba(139, 92, 246, 0.22);\n  border-radius: 4px;\n  padding: 1px 6px;\n}\n.kb-card-model { opacity: 0.55; }\n.kb-card-error-text { margin-top: 6px; font-size: 12px; color: #f87171; word-break: break-all; }\n.kb-card-worktree { margin-top: 4px; font-size: 11px; opacity: 0.5; word-break: break-all; }\n.kb-toast {\n  position: fixed;\n  left: 50%;\n  bottom: 24px;\n  transform: translateX(-50%);\n  background: var(--dsw-alias-bg-layer-2);\n  border: 1px solid var(--dsw-alias-border-l2);\n  color: var(--dsw-alias-label-primary);\n  padding: 8px 16px;\n  border-radius: 8px;\n  font-size: 13px;\n  z-index: 2147483000;\n  max-width: 70vw;\n}\n.kb-modal-backdrop {\n  position: fixed;\n  inset: 0;\n  background: rgba(0, 0, 0, 0.5);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  z-index: 2147482900;\n}\n.kb-modal {\n  width: 460px;\n  max-width: 90vw;\n  max-height: 85vh;\n  overflow-y: auto;\n  background: var(--dsw-alias-bg-layer-1);\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: 12px;\n  padding: 18px;\n  color: var(--dsw-alias-label-primary);\n}\n.kb-modal-wide { width: 640px; }\n/* Task-detail bottom panel: docks at the bottom of the board page, fills the\n   full board width and exactly half of the board height (the lanes column\n   above flexes to the remaining space). */\n.kb-detail-panel {\n  flex: 0 0 50%;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n  margin-top: 10px;\n  background: var(--dsw-alias-bg-layer-2);\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: 12px;\n  overflow: hidden;\n  color: var(--dsw-alias-label-primary);\n}\n.kb-detail-panel-head {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 10px;\n  padding: 10px 14px;\n  border-bottom: 1px solid rgba(128, 128, 128, 0.2);\n  flex: 0 0 auto;\n}\n.kb-detail-panel-head .kb-modal-title { margin-bottom: 0; }\n.kb-detail-panel-body {\n  flex: 1 1 auto;\n  min-height: 0;\n  overflow-y: auto;\n  padding: 14px;\n}\n.kb-detail-close {\n  flex: none;\n  width: 28px;\n  height: 28px;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  border: 1px solid transparent;\n  border-radius: 6px;\n  background: transparent;\n  color: inherit;\n  font-size: 15px;\n  line-height: 1;\n  opacity: 0.75;\n  cursor: pointer;\n}\n.kb-detail-close:hover { background: rgba(128, 128, 128, 0.18); opacity: 1; }\n.kb-modal-title { font-size: 16px; font-weight: 700; margin-bottom: 14px; display: flex; align-items: center; gap: 10px; }\n.kb-field { display: block; margin-bottom: 12px; }\n.kb-field > span { display: block; font-size: 12px; opacity: 0.75; margin-bottom: 4px; }\n.kb-field-hint {\n  display: block;\n  font-size: 11px;\n  opacity: 0.55;\n  margin-top: 4px;\n}\n.kb-field-hint-skill {\n  opacity: 0.9;\n  color: #a78bfa;\n}\n.kb-skill-menu-wrap { position: relative; }\n.kb-skill-menu {\n  position: absolute;\n  top: 100%;\n  left: 0;\n  right: 0;\n  z-index: 20;\n  margin: 2px 0 0;\n  padding: 4px;\n  list-style: none;\n  max-height: 180px;\n  overflow-y: auto;\n  border-radius: 8px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-alias-bg-overlay);\n  color: var(--dsw-alias-label-primary);\n  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);\n}\n.kb-skill-menu-item {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  padding: 6px 8px;\n  border-radius: 6px;\n  cursor: pointer;\n  font-size: 12px;\n  color: var(--dsw-alias-label-primary);\n}\n.kb-skill-menu-item-active { background: var(--dsw-alias-interactive-bg-hover); }\n.kb-skill-menu-name { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }\n.kb-skill-menu-desc {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 11px;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n.kb-field-row { display: flex; align-items: center; gap: 10px; justify-content: space-between; }\n.kb-input {\n  width: 100%;\n  box-sizing: border-box;\n  padding: 7px 10px;\n  border-radius: 6px;\n  border: 1px solid rgba(128, 128, 128, 0.35);\n  background: rgba(128, 128, 128, 0.1);\n  color: inherit;\n  font-size: 13px;\n}\n.kb-input-number { width: 90px; }\n.kb-textarea { min-height: 110px; resize: vertical; font-family: inherit; }\n.kb-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }\n.kb-detail-section { margin-bottom: 12px; }\n.kb-detail-label { font-size: 12px; opacity: 0.65; margin-bottom: 4px; }\n.kb-detail-skill {\n  display: inline-block;\n  font-size: 11px;\n  background: rgba(139, 92, 246, 0.22);\n  border-radius: 4px;\n  padding: 1px 6px;\n  margin-bottom: 4px;\n}\n.kb-detail-text { white-space: pre-wrap; word-break: break-all; font-size: 13px; }\n.kb-detail-error .kb-detail-text { color: #f87171; }\n.kb-detail-status {\n  font-size: 12px;\n  font-weight: 600;\n  border-radius: 4px;\n  padding: 1px 8px;\n  background: rgba(128, 128, 128, 0.2);\n}\n.kb-status-running, .kb-status-merging { background: rgba(59, 130, 246, 0.3) !important; }\n.kb-status-error { background: rgba(239, 68, 68, 0.3) !important; color: #f87171; }\n.kb-status-merged { background: rgba(34, 197, 94, 0.3) !important; }\n.kb-plan-summary { font-size: 13px; margin-bottom: 10px; }\n/* Phase cards: each plan phase is a card with an ordered number (kept from the\n   parent <ol>) and three labeled sections (goal / sessions / conclusion) split\n   by section titles and thin divider lines. */\n.kb-plan-phases { margin: 0; padding-left: 24px; }\n.kb-plan-phase {\n  margin-bottom: 10px;\n  padding: 8px 10px;\n  background: rgba(128, 128, 128, 0.08);\n  border: 1px solid rgba(128, 128, 128, 0.2);\n  border-radius: 8px;\n}\n.kb-plan-phase-head {\n  display: flex;\n  gap: 8px;\n  align-items: baseline;\n  padding-bottom: 6px;\n  margin-bottom: 6px;\n  border-bottom: 1px solid rgba(128, 128, 128, 0.16);\n}\n.kb-plan-phase-title { font-weight: 600; font-size: 13px; }\n.kb-plan-phase-id { font-size: 11px; opacity: 0.5; }\n.kb-plan-phase-body { display: flex; flex-direction: column; }\n/* Section isolation: label on top, thin divider between adjacent sections. */\n.kb-plan-phase-section { display: flex; flex-direction: column; }\n.kb-plan-phase-section + .kb-plan-phase-section {\n  margin-top: 6px;\n  padding-top: 6px;\n  border-top: 1px solid rgba(128, 128, 128, 0.14);\n}\n.kb-plan-phase-section-title { font-size: 11px; opacity: 0.55; margin-bottom: 3px; }\n.kb-plan-phase-goal { font-size: 12px; opacity: 0.85; white-space: pre-wrap; word-break: break-all; }\n.kb-plan-phase-sessions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }\n.kb-plan-phase-conclusion { font-size: 12px; opacity: 0.85; white-space: pre-wrap; word-break: break-all; }\n.kb-plan-phase-conclusion-item + .kb-plan-phase-conclusion-item { margin-top: 6px; }\n/* Running phase keeps the blue highlight; completed phases get success color. */\n.kb-plan-phase-current { border-color: rgba(59, 130, 246, 0.6); background: rgba(59, 130, 246, 0.08); }\n.kb-plan-phase-current .kb-plan-phase-title { color: #60a5fa; }\n.kb-plan-phase-completed { border-color: rgba(34, 197, 94, 0.45); background: rgba(34, 197, 94, 0.06); }\n.kb-plan-phase-completed .kb-plan-phase-title { color: #4ade80; }\n.kb-session-links { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }\n.kb-settings { display: flex; flex-direction: column; gap: 12px; max-width: 420px; }\n.kb-settings-saved { font-size: 12px; color: #4ade80; }\n.kb-footer-action {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  width: 32px;\n  height: 32px;\n  border-radius: 6px;\n  border: none;\n  background: transparent;\n  /* same foreground as the settings trigger (its trigger css uses this var) */\n  color: var(--dsw-alias-label-primary, inherit);\n  cursor: pointer;\n}\n.kb-footer-action:hover { background: rgba(128, 128, 128, 0.18); }\n.kb-footer-action-active { background: rgba(59, 130, 246, 0.25); }\n/* Wide mode borrows the settings trigger's metrics (34px tall, 14px label,\n   18px icon) so both controls read as siblings on the same line. */\n.kb-footer-action-wide {\n  width: auto;\n  height: 34px;\n  padding: 0 8px;\n  border-radius: 12px;\n  font-size: 14px;\n}\n.kb-footer-action-wide .kb-footer-label {\n  font-size: 14px;\n  line-height: 22px;\n}\n/* Theme following is handled by the --dsw-alias-* tokens above: they change\n   value with the shell's selected light/dark appearance, so no OS-level\n   prefers-color-scheme override is needed (and one would fight the app\n   theme when the two disagree). */\n/* Same-line placement WITHOUT moving any DOM: the sidebar foot area becomes\n   a reversed flex row, so its LAST child (the settings area) renders on the\n   LEFT and the FIRST child (footer actions = the kanban button) on the RIGHT\n   — exactly \"settings, then kanban\". The settings trigger flexes to fill the\n   remaining width; the button keeps its content width. */\n.kb-foot-row {\n  display: flex;\n  flex-direction: row-reverse;\n  align-items: stretch;\n  gap: 4px;\n}\n.kb-foot-row > div:first-child {\n  flex: none;\n  width: auto;\n  min-width: 0;\n  display: flex;\n  align-items: center;\n}\n.kb-foot-row > div:last-child {\n  flex: 1;\n  min-width: 0;\n}\n/* Rail (collapsed sidebar): column-reverse stacks the settings circle on top\n   and the kanban icon below it, both centered; the kanban button borrows the\n   settings trigger's rail chrome (36px circle) so the two match. */\n.kb-foot-rail {\n  flex-direction: column-reverse;\n  align-items: center;\n}\n.kb-foot-rail .kb-footer-action {\n  width: 36px;\n  height: 36px;\n  border-radius: 50%;\n  margin: 8px 0 10px;\n}\n.kb-footer-label {\n  max-width: 110px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n/* Narrow screens (mobile drawer / auto-collapse breakpoint): the drawer's\n   foot area is ~256-280px but the footer actions row carries the kanban\n   button PLUS mobile-nav's drawer actions (Files / session log), which\n   together exceed the row and squeeze the settings trigger to zero width\n   (row-reverse overflows left, clipping the button). Below the shell's\n   auto-collapse breakpoint, stack the settings row above the actions and\n   let the actions wrap so nothing is squeezed or clipped. */\n@media (max-width: 1023px) {\n  .kb-foot-row {\n    flex-direction: column-reverse;\n    align-items: stretch;\n  }\n  .kb-foot-row > div:first-child {\n    flex: none;\n    width: 100%;\n    display: flex;\n    flex-wrap: wrap;\n    justify-content: flex-start;\n    gap: 4px;\n    padding-top: 4px;\n  }\n  .kb-foot-row > div:last-child {\n    flex: none;\n    width: 100%;\n  }\n  /* The footer-actions entries are display:contents wrappers, so the kanban\n     button itself is a flex item of the wrapping actions row; pull it to the\n     first wrap position so it sits directly below the settings row (the\n     mobile-nav drawer actions follow on their own wrapped line). */\n  .kb-foot-row .kb-footer-action {\n    order: -1;\n  }\n}";
		const tagId = "@fonlan/dsh-task-kanban/board.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@fonlan/dsh-task-kanban";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region src/client/board.tsx
		function firstLine(text) {
			return text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
		}
		/** The leading `/skill-name` gesture at the start of the requirement input. */
		const SKILL_GESTURE = /^\s*\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/;
		/** Extract a leading `/skill-name` token plus the cleaned remainder. */
		function parseSkillGesture(raw) {
			const m = SKILL_GESTURE.exec(raw);
			if (m === null) return { requirement: raw.trim() };
			return {
				skill: m[1],
				requirement: raw.slice(m[0].length).trim()
			};
		}
		function statusLabel(card, t) {
			if (card.status === "error") switch (card.error?.kind) {
				case "interrupted": return t("interrupted");
				case "no_base_branch": return t("noBaseBranch");
				case "worktree_failed": return t("worktreeFailed");
				case "refine_failed": return t("refineFailed");
				case "phase_failed": return t("phaseFailed");
				case "merge_failed": return t("mergeFailed");
				default: return t("createFailed");
			}
			switch (card.status) {
				case "draft": return t("statusDraft");
				case "refining": return t("statusRefining");
				case "planned": return t("statusPlanned");
				case "queued": return t("statusQueued");
				case "running": return t("statusRunning");
				case "completed": return t("statusCompleted");
				case "merging": return t("statusMerging");
				case "merged": return t("statusMerged");
			}
		}
		const LANE_ORDER = [
			{
				key: "demand",
				labelKey: "laneDemand"
			},
			{
				key: "queue",
				labelKey: "laneQueue"
			},
			{
				key: "running",
				labelKey: "laneRunning"
			},
			{
				key: "completed",
				labelKey: "laneCompleted"
			},
			{
				key: "merged",
				labelKey: "laneMerged"
			}
		];
		const WS_STORAGE_KEY = "@fonlan/dsh-task-kanban:workspace";
		function BoardRoot(props) {
			const t = props.t ?? ((key, params) => {
				const dict = zh[key] ?? en[key];
				if (dict === void 0 || params === void 0) return dict ?? key;
				return dict.replace(/\{(\w+)\}/g, (m, name) => params[name] ?? m);
			});
			const useWorkspaces = props.useWorkspaces;
			const items = (useWorkspaces !== void 0 ? useWorkspaces((s) => s) : void 0)?.items ?? [];
			const useSessions = props.useSessions;
			const currentSessionId = (useSessions !== void 0 ? useSessions((s) => s) : void 0)?.current;
			const [selectedPath, setSelectedPath] = (0, react.useState)(() => {
				try {
					return localStorage.getItem(WS_STORAGE_KEY) ?? "";
				} catch {
					return "";
				}
			});
			const [cards, setCards] = (0, react.useState)([]);
			const [toast, setToast] = (0, react.useState)(null);
			const [detailId, setDetailId] = (0, react.useState)(null);
			const [newTaskOpen, setNewTaskOpen] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (selectedPath === "" && items.length > 0) setSelectedPath(items[0].path);
			}, [selectedPath, items]);
			const showToast = (0, react.useCallback)((message) => {
				setToast(message);
				window.setTimeout(() => setToast(null), 3500);
			}, []);
			const refresh = (0, react.useCallback)(async () => {
				if (selectedPath === "") return;
				try {
					setCards(await api.list(selectedPath));
				} catch (error) {
					showToast(error instanceof Error ? error.message : String(error));
				}
			}, [selectedPath, showToast]);
			(0, react.useEffect)(() => {
				refresh();
				const timer = window.setInterval(() => {
					refresh();
				}, 2500);
				return () => window.clearInterval(timer);
			}, [refresh]);
			const byLane = (0, react.useMemo)(() => {
				const map = {
					demand: [],
					queue: [],
					running: [],
					completed: [],
					merged: []
				};
				for (const card of cards) map[laneOf(card)].push(card);
				for (const lane of LANE_ORDER) map[lane.key].sort((a, b) => a.createdAt - b.createdAt);
				return map;
			}, [cards]);
			const handleDrop = (0, react.useCallback)(async (target, event) => {
				event.preventDefault();
				const cardId = event.dataTransfer.getData("text/plain");
				if (cardId === "") return;
				const card = cards.find((c) => c.id === cardId);
				if (card === void 0) return;
				if (target === "queue" && card.status !== "running" && card.plan === void 0) {
					showToast(t("dragNoPlan"));
					return;
				}
				try {
					const result = await api.move(cardId, target);
					if (!result.ok) showToast(t("actionFailed", { message: result.message ?? "" }));
					refresh();
				} catch (error) {
					showToast(error instanceof Error ? error.message : String(error));
				}
			}, [
				cards,
				refresh,
				showToast,
				t
			]);
			const openSession = (0, react.useCallback)((sessionId) => {
				const ctx = getClient();
				exitBoard();
				if (ctx === null) return;
				try {
					ctx.sessions.open(sessionId);
				} catch {
					showToast(t("sessionNotListed"));
				}
			}, [showToast, t]);
			if (items.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "kb-board kb-empty",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "kb-empty-text",
					children: t("noWorkspace")
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "kb-board",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "kb-board-header",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-board-title",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
								className: "kb-ws-select",
								value: selectedPath,
								onChange: (e) => {
									setSelectedPath(e.target.value);
									try {
										localStorage.setItem(WS_STORAGE_KEY, e.target.value);
									} catch {}
								},
								children: items.map((w) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: w.path,
									children: w.title
								}, w.workspaceId))
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "kb-btn kb-btn-primary",
								onClick: () => setNewTaskOpen(true),
								children: t("newTask")
							})]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "kb-lanes",
						children: LANE_ORDER.map((lane) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-lane" + (DROP_RULES[lane.key].length > 0 ? " kb-lane-drop" : ""),
							onDragOver: (e) => {
								if (DROP_RULES[lane.key].length > 0) e.preventDefault();
							},
							onDrop: (e) => {
								handleDrop(lane.key, e);
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "kb-lane-head",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "kb-lane-title",
									children: t(lane.labelKey)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "kb-lane-count",
									children: byLane[lane.key].length
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-lane-body",
								children: byLane[lane.key].map((card) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CardView, {
									card,
									t,
									onToggle: () => setDetailId(detailId === card.id ? null : card.id)
								}, card.id))
							})]
						}, lane.key))
					}),
					toast !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "kb-toast",
						children: toast
					}),
					newTaskOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NewTaskModal, {
						t,
						workspaces: items,
						selectedPath,
						sessionId: currentSessionId,
						onClose: () => setNewTaskOpen(false),
						onCreated: () => {
							setNewTaskOpen(false);
							refresh();
						},
						onError: (message) => showToast(message)
					}),
					detailId !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DetailPanel, {
						card: cards.find((c) => c.id === detailId) ?? null,
						t,
						onClose: () => setDetailId(null),
						onChanged: () => {
							setDetailId(null);
							refresh();
						},
						onToast: showToast,
						onOpenSession: openSession
					})
				]
			});
		}
		function CardView({ card, t, onToggle }) {
			const draggable = card.status === "planned" || card.status === "queued" || card.status === "running";
			const title = card.plan !== void 0 && card.plan.title !== "" ? card.plan.title : firstLine(card.requirement);
			const badge = statusLabel(card, t);
			const phaseInfo = card.status === "running" || card.status === "error" ? card.currentPhase < card.phaseCount ? t("phaseProgress", {
				current: card.currentPhase + 1,
				total: card.phaseCount
			}) : "" : "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "kb-card" + (card.status === "error" ? " kb-card-error" : "") + (card.status === "running" ? " kb-card-running" : ""),
				draggable,
				onDragStart: (e) => {
					e.dataTransfer.setData("text/plain", card.id);
					e.dataTransfer.effectAllowed = "move";
				},
				onClick: onToggle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "kb-card-title",
						children: title
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "kb-card-meta",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "kb-card-badge",
								children: badge
							}),
							phaseInfo !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "kb-card-phase",
								children: phaseInfo
							}),
							card.skill !== void 0 && card.skill !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "kb-card-skill",
								children: ["/ ", card.skill]
							}),
							card.model !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "kb-card-model",
								children: card.model
							})
						]
					}),
					card.status === "error" && card.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "kb-card-error-text",
						children: card.error.message
					}),
					card.status === "running" && card.gitMode === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "kb-card-worktree",
						children: card.worktreePath ?? ""
					})
				]
			});
		}
		/** An in-progress leading `/query` token (menu-open state). */
		const SKILL_MENU_RE = /^\s*\/([a-z0-9-]*)$/;
		function NewTaskModal({ t, workspaces, selectedPath, sessionId, onClose, onCreated, onError }) {
			const [requirement, setRequirement] = (0, react.useState)("");
			const [project, setProject] = (0, react.useState)(selectedPath);
			const [model, setModel] = (0, react.useState)("");
			const [modelProvider, setModelProvider] = (0, react.useState)("");
			const [models, setModels] = (0, react.useState)([]);
			const [skills, setSkills] = (0, react.useState)([]);
			const [menuQuery, setMenuQuery] = (0, react.useState)(null);
			const [menuIndex, setMenuIndex] = (0, react.useState)(0);
			const [busy, setBusy] = (0, react.useState)(false);
			const textareaRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				let alive = true;
				api.models().then((list) => {
					if (alive) setModels(list);
				}).catch(() => {
					if (alive) setModels([]);
				});
				api.settingsGet().then((s) => {
					if (alive && s.defaultModel !== "") setModel(s.defaultModel);
				}).catch(() => void 0);
				return () => {
					alive = false;
				};
			}, []);
			(0, react.useEffect)(() => {
				if (sessionId === void 0) return;
				let alive = true;
				gatewaySkillList(sessionId).then((list) => {
					if (alive) setSkills(list);
				}).catch(() => {
					if (alive) setSkills([]);
				});
				return () => {
					alive = false;
				};
			}, [sessionId]);
			const matches = skills.filter((s) => s.name.startsWith(menuQuery ?? ""));
			const menuVisible = menuQuery !== null && matches.length > 0;
			const selected = menuVisible ? matches[Math.min(menuIndex, matches.length - 1)] : void 0;
			/** Re-evaluate the leading-token menu state from the current value + caret. */
			const syncMenu = (value, caret) => {
				const head = value.slice(0, caret);
				const m = SKILL_MENU_RE.exec(head);
				if (m !== null) {
					setMenuQuery(m[1]);
					setMenuIndex(0);
					return;
				}
				setMenuQuery(null);
			};
			const selectSkill = (name) => {
				const caret = textareaRef.current?.selectionStart ?? requirement.length;
				const head = requirement.slice(0, caret);
				const m = SKILL_MENU_RE.exec(head);
				const inserted = `/${name} `;
				const newValue = m !== null ? inserted + requirement.slice(caret) : inserted + requirement;
				setRequirement(newValue);
				setMenuQuery(null);
				requestAnimationFrame(() => {
					const next = textareaRef.current;
					if (next !== null) {
						next.focus();
						const pos = inserted.length;
						next.setSelectionRange(pos, pos);
					}
				});
			};
			const onKeyDown = (e) => {
				if (!menuVisible) return;
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setMenuIndex((i) => (i + 1) % matches.length);
				} else if (e.key === "ArrowUp") {
					e.preventDefault();
					setMenuIndex((i) => (i - 1 + matches.length) % matches.length);
				} else if (e.key === "Enter") {
					e.preventDefault();
					if (selected !== void 0) selectSkill(selected.name);
				} else if (e.key === "Escape") {
					e.preventDefault();
					setMenuQuery(null);
				} else if (e.key === "Tab") {
					e.preventDefault();
					if (selected !== void 0) selectSkill(selected.name);
				}
			};
			const submit = async () => {
				if (requirement.trim() === "") {
					onError(t("requirementLabel") + " " + t("error"));
					return;
				}
				if (project === "") {
					onError(t("noWorkspace"));
					return;
				}
				const parsed = parseSkillGesture(requirement);
				setBusy(true);
				try {
					await api.create(project, parsed.requirement, model, modelProvider, parsed.skill);
					onCreated();
				} catch (error) {
					onError(error instanceof Error ? error.message : String(error));
					setBusy(false);
				}
			};
			const activeSkill = parseSkillGesture(requirement).skill;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "kb-modal-backdrop",
				onClick: busy ? void 0 : onClose,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "kb-modal",
					onClick: (e) => e.stopPropagation(),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "kb-modal-title",
							children: t("newTask")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "kb-field",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("requirementLabel") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "kb-skill-menu-wrap",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
										ref: textareaRef,
										className: "kb-input kb-textarea",
										value: requirement,
										placeholder: t("requirementPlaceholder"),
										onChange: (e) => {
											const value = e.target.value;
											setRequirement(value);
											syncMenu(value, e.target.selectionStart ?? value.length);
										},
										onKeyDown
									}), menuVisible && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
										className: "kb-skill-menu",
										role: "listbox",
										children: matches.map((s, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
											role: "option",
											"aria-selected": i === menuIndex,
											className: "kb-skill-menu-item" + (i === menuIndex ? " kb-skill-menu-item-active" : ""),
											onMouseDown: (e) => {
												e.preventDefault();
												selectSkill(s.name);
											},
											onMouseEnter: () => setMenuIndex(i),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "kb-skill-menu-name",
												children: ["/", s.name]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "kb-skill-menu-desc",
												children: s.modelInvocable ? s.description : `${t("skillMenuUserOnly")} · ${s.description}`
											})]
										}, s.name))
									})]
								}),
								activeSkill !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "kb-field-hint kb-field-hint-skill",
									children: t("skillHint", { skill: activeSkill })
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "kb-field-hint",
									children: t("skillGestureHint")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "kb-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("project") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
								className: "kb-input",
								value: project,
								onChange: (e) => setProject(e.target.value),
								children: workspaces.map((w) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: w.path,
									children: w.title
								}, w.workspaceId))
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "kb-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("model") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: "kb-input",
								value: model,
								onChange: (e) => {
									const id = e.target.value;
									setModel(id);
									const found = models.find((m) => m.id === id);
									setModelProvider(found?.provider ?? "");
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("modelPlaceholder")
								}), models.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: m.id,
									children: m.name ?? m.id
								}, m.provider + "/" + m.id))]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-modal-actions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "kb-btn",
								onClick: onClose,
								disabled: busy,
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "kb-btn kb-btn-primary",
								onClick: () => {
									submit();
								},
								disabled: busy,
								children: t("addAndRefine")
							})]
						})
					]
				})
			});
		}
		function DetailPanel({ card, t, onClose, onChanged, onToast, onOpenSession }) {
			const [busy, setBusy] = (0, react.useState)(false);
			if (card === null) return null;
			const act = async (fn) => {
				setBusy(true);
				try {
					await fn();
					onChanged();
				} catch (error) {
					onToast(error instanceof Error ? error.message : String(error));
					setBusy(false);
				}
			};
			const remove = async () => {
				if (!window.confirm(t("deleteConfirm"))) return;
				await act(() => api.remove(card.id));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "kb-detail-panel",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "kb-detail-panel-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "kb-modal-title",
						children: [card.plan !== void 0 && card.plan.title !== "" ? card.plan.title : firstLine(card.requirement), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "kb-detail-status kb-status-" + card.status,
							children: statusLabel(card, t)
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "kb-detail-close",
						"aria-label": t("close"),
						title: t("close"),
						onClick: onClose,
						children: "✕"
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "kb-detail-panel-body",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-detail-section",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "kb-detail-label",
									children: t("requirement")
								}),
								card.skill !== void 0 && card.skill !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "kb-detail-skill",
									children: t("skillBadge", { skill: card.skill })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "kb-detail-text",
									children: card.requirement
								})
							]
						}),
						card.plan !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-detail-section",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-detail-label",
								children: t("plan")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "kb-detail-plan",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "kb-plan-summary",
									children: card.plan.summary
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
									className: "kb-plan-phases",
									children: card.plan.phases.map((phase, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PhaseCard, {
										phase,
										phaseIndex: i,
										card,
										t,
										onOpenSession
									}, phase.id))
								})]
							})]
						}),
						card.sessions.refinement.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-detail-section",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-detail-label",
								children: t("refinementLabel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-session-links",
								children: card.sessions.refinement.map((sid) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "kb-btn kb-btn-small",
									onClick: () => onOpenSession(sid),
									children: [
										t("openSession"),
										" · ",
										sid.slice(0, 13)
									]
								}, sid))
							})]
						}),
						card.status === "error" && card.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-detail-section kb-detail-error",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-detail-label",
								children: t("error")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-detail-text",
								children: card.error.message
							})]
						}),
						card.merge?.mergeCommit !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-detail-section",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-detail-label",
								children: t("mergeLabel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "kb-detail-text",
								children: [
									t("commitLabel"),
									" ",
									card.merge.mergeCommit.slice(0, 12)
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-modal-actions",
							children: [
								card.status === "error" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "kb-btn kb-btn-primary",
									disabled: busy,
									onClick: () => {
										act(() => api.retry(card.id));
									},
									children: t("retry")
								}),
								(card.status === "running" || card.status === "merging") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "kb-btn",
									disabled: busy,
									onClick: () => {
										act(() => api.stop(card.id));
									},
									children: t("stop")
								}),
								card.status !== "running" && card.status !== "refining" && card.status !== "merging" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "kb-btn kb-btn-danger",
									disabled: busy,
									onClick: () => {
										remove();
									},
									children: t("delete")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "kb-btn",
									onClick: onClose,
									children: t("cancel")
								})
							]
						})
					]
				})]
			});
		}
		/** One plan phase rendered as a card with goal / sessions / conclusion sections. */
		function PhaseCard({ phase, phaseIndex, card, t, onOpenSession }) {
			const attempts = card.sessions.phases.filter((a) => a.phaseIndex === phaseIndex);
			const summaries = attempts.filter((a) => a.summary !== void 0 && a.summary.trim() !== "").map((a) => a.summary);
			const isCurrent = phaseIndex === card.currentPhase && card.status === "running";
			const isCompleted = summaries.length > 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "kb-plan-phase" + (isCurrent ? " kb-plan-phase-current" : "") + (isCompleted ? " kb-plan-phase-completed" : ""),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "kb-plan-phase-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "kb-plan-phase-title",
						children: phase.title
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "kb-plan-phase-id",
						children: phase.id
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "kb-plan-phase-body",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-plan-phase-section",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-plan-phase-section-title",
								children: t("phaseGoal")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-plan-phase-goal",
								children: phase.goal
							})]
						}),
						attempts.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-plan-phase-section",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-plan-phase-section-title",
								children: t("phaseSessions")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PhaseSessions, {
								attempts,
								t,
								onOpenSession
							})]
						}),
						summaries.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "kb-plan-phase-section",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-plan-phase-section-title",
								children: t("phaseConclusion")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "kb-plan-phase-conclusion",
								children: summaries.map((s, idx) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "kb-plan-phase-conclusion-item",
									children: s
								}, idx))
							})]
						})
					]
				})]
			});
		}
		/** Open-session buttons for one phase's attempts (retries append more). */
		function PhaseSessions({ attempts, t, onOpenSession }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "kb-plan-phase-sessions",
				children: attempts.map((a) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "kb-btn kb-btn-small",
					onClick: () => onOpenSession(a.sessionId),
					children: [
						t("openSession"),
						" · ",
						a.sessionId.slice(0, 13)
					]
				}, a.sessionId))
			});
		}
		//#endregion
		//#region src/client/sections.tsx
		/** Sidebar footer entry: toggles the kanban board main view.
		*  The shell renders footer actions on their own row ABOVE the settings row,
		*  so the button is reparented into the settings area to sit on the same
		*  line, right of the Settings trigger (see board.css .kb-settings-row). */
		function KanbanFooterButton({ wide, t }) {
			const open = useBoardOpen();
			const ref = (0, react.useRef)(null);
			const label = t !== void 0 ? t(open ? "closeBoard" : "openBoard") : "Task Kanban";
			(0, react.useEffect)(() => {
				const btn = ref.current;
				if (btn === null) return;
				let foot = null;
				let disposed = false;
				const findFoot = () => {
					let el = btn.parentElement;
					while (el !== null && el !== document.body && el.parentElement !== null) {
						const last = el.lastElementChild;
						const hasTrigger = last !== null && (last.querySelector?.("button[aria-haspopup=\"dialog\"]") !== null || last.querySelector?.("button[aria-haspopup=\"menu\"]") !== null);
						const isLastChild = el.parentElement.lastElementChild === el;
						if (hasTrigger && isLastChild) return el;
						el = el.parentElement;
					}
					return null;
				};
				const tryApply = () => {
					if (foot === null) try {
						foot = findFoot();
					} catch {
						foot = null;
					}
					if (foot === null) return false;
					try {
						foot.classList.add("kb-foot-row");
						foot.classList.toggle("kb-foot-rail", wide !== true);
					} catch {}
					return true;
				};
				let applied = false;
				try {
					applied = tryApply();
				} catch (error) {
					console.error("[@fonlan/dsh-task-kanban] foot placement error:", error);
				}
				if (!applied) {
					const observer = new MutationObserver(() => {
						if (disposed) return;
						if (tryApply()) observer.disconnect();
					});
					observer.observe(document.body, {
						childList: true,
						subtree: true
					});
					const timer = window.setInterval(() => {
						if (disposed) {
							window.clearInterval(timer);
							return;
						}
						if (tryApply()) {
							observer.disconnect();
							window.clearInterval(timer);
						}
					}, 1e3);
					window.setTimeout(() => {
						observer.disconnect();
						window.clearInterval(timer);
						if (foot === null) {
							const chain = [];
							let el = btn.parentElement;
							while (el !== null && chain.length < 8) {
								chain.push(el.tagName + "." + String(el.className).slice(0, 60));
								el = el.parentElement;
							}
							console.warn("[@fonlan/dsh-task-kanban] could not locate the sidebar foot area:", chain);
						}
					}, 15e3);
					return () => {
						disposed = true;
						observer.disconnect();
						window.clearInterval(timer);
						try {
							foot?.classList.remove("kb-foot-row");
							foot?.classList.remove("kb-foot-rail");
						} catch {}
					};
				}
				return () => {
					try {
						foot?.classList.remove("kb-foot-row");
						foot?.classList.remove("kb-foot-rail");
					} catch {}
				};
			}, [wide]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				ref,
				type: "button",
				className: "kb-footer-action" + (wide === true ? " kb-footer-action-wide" : "") + (open ? " kb-footer-action-active" : ""),
				"aria-label": label,
				title: label,
				onClick: () => toggleBoard(),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChecklistOutline14, { size: wide === true ? 16 : 18 }), wide === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "kb-footer-label",
					children: t !== void 0 ? t("kanban") : "Kanban"
				})]
			});
		}
		/** Plugin settings section: global parallel workers + default model. */
		function KanbanSettingsSection({ t }) {
			const tr = t ?? ((key) => key);
			const [settings, setSettings] = (0, react.useState)({
				maxParallelWorkers: 1,
				defaultModel: ""
			});
			const [models, setModels] = (0, react.useState)([]);
			const [saved, setSaved] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				let alive = true;
				api.settingsGet().then((s) => {
					if (alive) setSettings(s);
				}).catch(() => void 0);
				api.models().then((list) => {
					if (alive) setModels(list);
				}).catch(() => void 0);
				return () => {
					alive = false;
				};
			}, []);
			const commit = async (patch) => {
				try {
					const next = await api.settingsSet(patch);
					setSettings(next);
					setSaved(true);
					window.setTimeout(() => setSaved(false), 1500);
				} catch {}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "kb-settings",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: "kb-field kb-field-row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: tr("maxParallelWorkers") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "kb-input kb-input-number",
							type: "number",
							min: 1,
							step: 1,
							value: settings.maxParallelWorkers,
							onChange: (e) => {
								const value = Math.max(1, Math.floor(Number(e.target.value) || 1));
								setSettings((s) => ({
									...s,
									maxParallelWorkers: value
								}));
								commit({ maxParallelWorkers: value });
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: "kb-field kb-field-row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: tr("defaultModel") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "kb-input",
							value: settings.defaultModel,
							onChange: (e) => {
								commit({ defaultModel: e.target.value });
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "—"
							}), models.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: m.id,
								children: m.name ?? m.id
							}, m.provider + "/" + m.id))]
						})]
					}),
					saved && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "kb-settings-saved",
						children: tr("saved")
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.tsx
		/** Services required before mounting (provided by the client runtime). */
		const inject = [
			"slots",
			"sessions",
			"workspaces",
			"locale"
		];
		/** Client plugin body. */
		function apply(ctx) {
			setClient(ctx);
			setBoardRoot(BoardRoot);
			bindSessionNavigation(ctx);
			const t = ctx.locale.bind(LOCALE_NS);
			ctx.effect(() => {
				const off = ctx.locale.register(LOCALE_NS, {
					zh,
					en
				});
				return () => off();
			}, "task-kanban: dictionaries");
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "task-kanban",
				order: 60,
				label: () => t("kanban"),
				locale: LOCALE_NS
			}, KanbanFooterButton));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "task-kanban",
				order: 200,
				label: () => t("settingsTitle"),
				locale: LOCALE_NS
			}, KanbanSettingsSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map