import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isSkillName, isUserInvocable, renderSkillContent } from "@deepseek-ai/dsh-skill";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/server/settings.ts
const KANBAN_SETTINGS_NS = settingsNamespace("task-kanban");
const KanbanSettingsSchema = z.object({
	maxParallelWorkers: z.natural().min(1).default(1),
	defaultModel: z.string().default("")
});
function registerSettings(ctx) {
	let current = {
		maxParallelWorkers: 1,
		defaultModel: ""
	};
	let service;
	ctx.inject(["settings"], (sctx) => {
		service = sctx.settings;
		const scope = service.register(KANBAN_SETTINGS_NS, KanbanSettingsSchema);
		current = scope.get();
		scope.watch((next) => {
			current = next;
		});
	});
	return {
		get: () => current,
		defaultModelRoute: () => {
			if (service === void 0) return {};
			try {
				const descriptors = service.describe({ redactSecrets: true });
				for (const d of descriptors) if (String(d.ns) === "agent-default-model") {
					const v = d.value ?? {};
					return {
						provider: v.provider,
						model: v.model
					};
				}
			} catch {}
			return {};
		},
		update: async (patch) => {
			if (service === void 0) throw new Error("@fonlan/dsh-task-kanban: settings service is not available in this profile");
			await service.update(KANBAN_SETTINGS_NS, patch);
		}
	};
}
//#endregion
//#region src/server/task-store.ts
const TASKS_REL = [
	".dsh",
	"task-kanban",
	"tasks"
];
/**
* File-backed task store: one JSON file per card under
* `<workspace>/.dsh/task-kanban/tasks/<id>.json`. In-process cache plus
* atomic (tmp+rename) writes, with a per-card mutex so worker and RPC
* mutations never interleave.
*/
var TaskStore = class {
	cache = /* @__PURE__ */ new Map();
	locks = /* @__PURE__ */ new Map();
	taskDir(workspacePath) {
		return join(workspacePath, ...TASKS_REL);
	}
	fileOf(workspacePath, id) {
		return join(this.taskDir(workspacePath), `${id}.json`);
	}
	withLock(key, fn) {
		const next = (this.locks.get(key) ?? Promise.resolve()).then(fn, fn);
		this.locks.set(key, next.catch(() => void 0));
		return next;
	}
	async list(workspacePath) {
		const dir = this.taskDir(workspacePath);
		let files;
		try {
			files = await readdir(dir);
		} catch {
			return [];
		}
		const out = [];
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const id = f.slice(0, -5);
			const card = await this.get(workspacePath, id);
			if (card !== void 0) out.push(card);
		}
		out.sort((a, b) => a.createdAt - b.createdAt);
		return out;
	}
	async get(workspacePath, id) {
		const cached = this.cache.get(id);
		if (cached !== void 0 && cached.workspacePath === workspacePath) return cached;
		try {
			const raw = await readFile(this.fileOf(workspacePath, id), "utf8");
			const card = JSON.parse(raw);
			this.cache.set(id, card);
			return card;
		} catch {
			return;
		}
	}
	async create(input) {
		const card = {
			schemaVersion: 1,
			id: randomUUID(),
			workspacePath: input.workspacePath,
			requirement: input.requirement,
			model: input.model,
			...input.provider !== void 0 ? { provider: input.provider } : {},
			...input.skill !== void 0 && input.skill !== "" ? { skill: input.skill } : {},
			status: input.status ?? "draft",
			currentPhase: 0,
			phaseCount: 0,
			sessions: {
				refinement: [],
				phases: [],
				merge: []
			},
			createdAt: Date.now()
		};
		await this.write(card);
		return card;
	}
	/** Run a mutation under the card's lock; returns the updated card. */
	async mutate(id, fn, workspacePath) {
		return this.withLock(id, async () => {
			let card = this.cache.get(id);
			if ((card === void 0 || workspacePath !== void 0 && card.workspacePath !== workspacePath) && workspacePath !== void 0) card = await this.get(workspacePath, id);
			if (card === void 0) return void 0;
			await fn(card);
			await this.write(card);
			return card;
		});
	}
	async write(card) {
		const dir = this.taskDir(card.workspacePath);
		await mkdir(dir, { recursive: true });
		const file = this.fileOf(card.workspacePath, card.id);
		const tmp = file + ".tmp";
		await writeFile(tmp, JSON.stringify(card, null, 2), "utf8");
		await rename(tmp, file);
		this.cache.set(card.id, card);
	}
	async remove(workspacePath, id) {
		await this.withLock(id, async () => {
			this.cache.delete(id);
			try {
				await rm(this.fileOf(workspacePath, id), { force: true });
			} catch {}
		});
	}
};
//#endregion
//#region src/server/git.ts
/** Thin typed wrapper over the git CLI (all merge/web-tree flow runs here). */
const execFileAsync = promisify(execFile);
async function runGit(cwd, args) {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, {
			cwd,
			maxBuffer: 134217728,
			timeout: 6e5
		});
		return {
			code: 0,
			stdout: String(stdout),
			stderr: String(stderr)
		};
	} catch (error) {
		const e = error;
		return {
			code: typeof e.code === "number" ? e.code : 1,
			stdout: e.stdout !== void 0 ? String(e.stdout) : "",
			stderr: e.stderr !== void 0 ? String(e.stderr) : String(error)
		};
	}
}
async function isGitRepo(dir) {
	const r = await runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
	return r.code === 0 && r.stdout.trim() === "true";
}
async function hasBranch(dir, name) {
	return (await runGit(dir, [
		"rev-parse",
		"--verify",
		`refs/heads/${name}`
	])).code === 0;
}
async function detectBaseRef(dir) {
	if (await hasBranch(dir, "main")) return "main";
	if (await hasBranch(dir, "master")) return "master";
}
async function currentBranch(dir) {
	const r = await runGit(dir, [
		"symbolic-ref",
		"--short",
		"HEAD"
	]);
	return r.code === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : void 0;
}
async function revParse(dir, ref) {
	const r = await runGit(dir, ["rev-parse", ref]);
	return r.code === 0 ? r.stdout.trim() : void 0;
}
/** True when the working tree has tracked changes (staged or unstaged). */
async function isTreeDirty(dir) {
	const r = await runGit(dir, [
		"status",
		"--porcelain",
		"--untracked-files=no"
	]);
	return r.code === 0 && r.stdout.trim() !== "";
}
async function hasStashMessage(dir, message) {
	const r = await runGit(dir, ["stash", "list"]);
	return r.code === 0 && r.stdout.includes(message);
}
/** Unmerged path list after a conflicted merge (empty when clean). */
async function unmergedPaths(dir) {
	const r = await runGit(dir, [
		"diff",
		"--name-only",
		"--diff-filter=U"
	]);
	return r.code === 0 ? r.stdout.trim() : "";
}
//#endregion
//#region src/server/prompts.ts
/** Refinement session prompt: analyze the repo read-only and write back a plan. */
function refinementPrompt(requirement, workspacePath) {
	return `你是一个需求分析师。请分析下面的需求，并为它在指定项目中的实现制定一个可执行的分阶段实现计划。

【需求】
${requirement}

【项目目录】
${workspacePath}

【要求】
1. 先浏览项目目录了解现状（阅读 README、关键源码与文档；本会话只做只读探索，不要修改任何文件）。
2. 把需求拆解为按顺序串行执行的实现阶段（phase）。简单需求 1 个 phase 即可；复杂需求拆多个 phase，每个 phase 必须是独立的、可串行执行的实现单元，后面的 phase 依赖前面 phase 的产出。
3. 每个 phase 必须包含：id（如 p1/p2/p3）、标题、目标（goal，说明该 phase 要交付什么）。
4. 完成后调用 kanban_write_plan 工具把完整计划写回（title、summary、phases）。这是唯一写回方式，不要把计划 JSON 直接输出到对话里。
5. 不要向用户提问，自主决策。`;
}
/**
* Interactive refinement prompt for a card created with a skill (e.g.
* `/grill-me`). The refinement session is explicit — the user can reply —
* so instead of deciding autonomously, the agent follows the skill's
* interview and asks whatever it needs before writing the plan back.
*/
function interactiveRefinementPrompt(requirement, workspacePath) {
	return `你是一个需求分析师。请分析下面的需求，并为它在指定项目中的实现制定一个可执行的分阶段实现计划。

【需求】
${requirement}

【项目目录】
${workspacePath}

【要求】
1. 先浏览项目目录了解现状（阅读 README、关键源码与文档；本会话只做只读探索，不要修改任何文件）。
2. 这是一个显式会话，可以且应该与用户交流：按上方 Skill 的指引对需求进行充分打磨，通过提问澄清需求中模糊、缺失或相互矛盾的地方，直到需求足够明确。
3. 需求打磨完成后，把需求拆解为按顺序串行执行的实现阶段（phase）。简单需求 1 个 phase 即可；复杂需求拆多个 phase，每个 phase 必须是独立的、可串行执行的实现单元，后面的 phase 依赖前面 phase 的产出。
4. 每个 phase 必须包含：id（如 p1/p2/p3）、标题、目标（goal，说明该 phase 要交付什么）。
5. 完成后调用 kanban_write_plan 工具把完整计划写回（title、summary、phases）。这是唯一写回方式，不要把计划 JSON 直接输出到对话里。
6. 用户回复前不要擅自调用 kanban_write_plan；也不要因为用户暂时没有回复就放弃，等待用户回答即可。`;
}
/** Phase implementation session prompt; identical on retries (the model reads git status/diff itself). */
function phasePrompt(card, phaseIndex, workdir) {
	const plan = card.plan;
	const phase = plan.phases[phaseIndex];
	return `你是一个软件实现工程师。请实现下面计划中的第 ${phaseIndex + 1}/${plan.phases.length} 个 phase。你的工作目录是 ${workdir}，只允许在这个目录内工作。

【完整实现计划】
${JSON.stringify(plan, null, 2)}

【当前 phase】
id: ${phase.id}
标题: ${phase.title}
目标: ${phase.goal}

【要求】
1. 先查看工作目录现状（git status、目录与文件结构、已有代码），判断此前已完成的工作，然后实现当前 phase 的目标。如果这是一次重试/续跑，请先搞清楚现场再继续。
2. 只做当前 phase 范围内的实现；后续 phase 由其他会话完成。不要进入 plan mode。
3. 禁止执行 git commit / git push / git merge / git rebase / git stash / git reset（提交与合并由外部系统负责）；允许 git status / git diff 等只读命令。
4. 不要向用户提问，自主决策；不要调用 kanban_write_plan。
5. 完成后必须调用 kanban_phase_complete 工具，并在 summary 中简要说明本 phase 完成了什么。只有显式调用该工具才算完成。`;
}
/** Merge-conflict resolution session prompt: resolve conflicts only, never commit. */
function mergePrompt(workdir, conflicts) {
	return `你是一个 git 合并冲突解决专家。目录 ${workdir} 中存在合并冲突，请逐个解决。

【冲突文件】
${conflicts}

【要求】
1. 逐个查看冲突文件（阅读文件内容、git diff），手动解决所有冲突标记（<<<<<<<、=======、>>>>>>>）。
2. 只修改冲突文件以解决冲突，不要做任何无关改动；不要执行 git commit / git add / git merge / git stash。
3. 解决完成后调用 kanban_merge_resolved 工具声明完成（可附简短说明）。`;
}
//#endregion
//#region src/server/skills.ts
/**
* The public skill-name gesture shape: a whitespace-bounded `/name` token
* matching the grammar `tool-skill` uses (kebab-case letters/digits), at the
* very start of the input (leading whitespace allowed). A second `/` or
* non-boundary character breaks the match, keeping file paths (`/usr/bin`)
* and fractions (`5/8`) out.
*/
const SKILL_GESTURE = /^\s*\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/;
/**
* Extract a leading `/skill-name` gesture from raw create-task input. Only a
* token at the very start selects a skill; tokens later in the text are
* ordinary requirement prose (the user might legitimately mention paths or
* fractions). The name is grammar-validated but not registry-checked here —
* unknown names surface as a refinement error with a clear message.
*/
function parseSkillGesture(raw) {
	const m = SKILL_GESTURE.exec(raw);
	if (m === null) return { requirement: raw.trim() };
	return {
		skill: m[1],
		requirement: raw.slice(m[0].length).trim()
	};
}
/** Resolve the host skill registry, or undefined when this profile lacks one. */
function skillRegistry(ctx) {
	try {
		return ctx.get("skills");
	} catch {
		return;
	}
}
/**
* Build the instructions-form message carrying the rendered skill body, the
* same shape a user `/grill-me` invocation injects through `tool-skill`. The
* `skill-invocation` source is what the transcript UI decorates as a skill
* chip; the content is the canonical `<skill_content>` block.
*/
function skillInvocationMessage(skill) {
	return createUserMessage({
		content: [{
			type: "text",
			text: renderSkillContent(skill)
		}],
		source: {
			kind: "skill-invocation",
			name: skill.name,
			form: "instructions"
		}
	});
}
/**
* Load the skill body the card names, scoped to the refinement agent so
* preset-layer providers (the filesystem skill roots) are visible. Returns
* undefined when the skill is unknown, not user-invocable, or the registry is
* absent — the caller decides how to surface that.
*/
async function loadCardSkill(ctx, name, cwd, scope) {
	if (name === void 0 || !isSkillName(name)) return void 0;
	const registry = skillRegistry(ctx);
	if (registry === void 0) return void 0;
	const skill = await registry.get(name, {
		cwd,
		scope
	});
	if (skill === void 0 || !isUserInvocable(skill)) return void 0;
	return skill;
}
//#endregion
//#region src/shared/plan.ts
function validatePlan(input) {
	if (typeof input !== "object" || input === null) return {
		ok: false,
		message: "计划必须是对象"
	};
	const obj = input;
	if (typeof obj.title !== "string" || obj.title.trim() === "") return {
		ok: false,
		message: "title 不能为空"
	};
	if (typeof obj.summary !== "string" || obj.summary.trim() === "") return {
		ok: false,
		message: "summary 不能为空"
	};
	if (!Array.isArray(obj.phases) || obj.phases.length === 0) return {
		ok: false,
		message: "phases 必须是非空数组"
	};
	const seen = /* @__PURE__ */ new Set();
	for (const phase of obj.phases) {
		if (typeof phase !== "object" || phase === null) return {
			ok: false,
			message: "phase 必须是对象"
		};
		const p = phase;
		if (typeof p.id !== "string" || typeof p.title !== "string" || typeof p.goal !== "string") return {
			ok: false,
			message: "每个 phase 都必须包含 id/title/goal"
		};
		if (p.id.trim() === "" || p.title.trim() === "" || p.goal.trim() === "") return {
			ok: false,
			message: "每个 phase 的 id/title/goal 都不能为空"
		};
		if (seen.has(p.id)) return {
			ok: false,
			message: `phase id 重复: ${p.id}`
		};
		seen.add(p.id);
	}
	return {
		ok: true,
		plan: {
			schemaVersion: 1,
			title: obj.title,
			summary: obj.summary,
			phases: obj.phases.map((p) => ({
				id: p.id,
				title: p.title,
				goal: p.goal
			}))
		}
	};
}
//#endregion
//#region src/server/tools.ts
/**
* The three kanban model-facing tools, registered SCOPED into the sessions
* that need them (only refinement/phase/merge agents see them):
*  - kanban_write_plan      → refinement session writes the plan back to the card
*  - kanban_phase_complete  → a phase implementation session declares its phase done
*  - kanban_merge_resolved  → a conflict merge session declares conflicts resolved
*/
function registerKanbanTools(agentCtx, resolver) {
	agentCtx.tools.register(defineTool({
		name: "kanban_write_plan",
		description: "把当前需求的完整分阶段实现计划写回任务卡片。调用一次，参数为完整计划（title、summary、按执行顺序排列的 phases）。成功写回后本细化会话即结束。",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "计划标题"
			},
			summary: {
				type: "string",
				required: true,
				description: "计划摘要"
			},
			phases: {
				type: "array",
				required: true,
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						id: {
							type: "string",
							required: true,
							description: "阶段 id，如 p1"
						},
						title: {
							type: "string",
							required: true,
							description: "阶段标题"
						},
						goal: {
							type: "string",
							required: true,
							description: "阶段目标：本阶段要交付什么"
						}
					}
				},
				description: "按顺序串行执行的实现阶段；必须非空"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					taskId: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `实现计划已写回任务卡片 ${value.taskId}。`
			}]
		},
		async execute(args, exec) {
			const sessionId = exec.agent?.id;
			const cardId = resolver.cardOfSession(sessionId);
			if (cardId === void 0) throw new Error("当前会话没有关联的任务卡片，无法写回计划");
			const result = validatePlan(args);
			if (!result.ok) throw new Error(result.message);
			const plan = result.plan;
			await resolver.writePlan(cardId, plan);
			exec.concludeTurn();
			return {
				ok: true,
				taskId: cardId
			};
		}
	}));
	agentCtx.tools.register(defineTool({
		name: "kanban_phase_complete",
		description: "声明当前 phase 实现完成。在工作完成后必须显式调用本工具（附完成摘要），否则该 phase 会被视为未完成。",
		parameters: { summary: {
			type: "string",
			required: true,
			description: "本 phase 完成了什么的简要说明"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					phase: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `phase ${value.phase} 已标记完成。`
			}]
		},
		async execute(args, exec) {
			const sessionId = exec.agent?.id;
			if (resolver.cardOfSession(sessionId) === void 0) throw new Error("当前会话没有关联的任务卡片");
			if (typeof args.summary !== "string" || args.summary.trim() === "") throw new Error("summary 不能为空");
			const phase = await resolver.phaseComplete(sessionId, args.summary);
			exec.concludeTurn();
			return {
				ok: true,
				phase
			};
		}
	}));
	agentCtx.tools.register(defineTool({
		name: "kanban_merge_resolved",
		description: "声明当前目录中的合并冲突已全部解决。只用于合并冲突解决会话；声明后本会话即将结束。",
		parameters: { summary: {
			type: "string",
			description: "可选的解决方案说明"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { ok: {
					type: "boolean",
					required: true
				} }
			},
			render: () => [{
				type: "text",
				text: "冲突已标记为解决。"
			}]
		},
		async execute(_args, exec) {
			const sessionId = exec.agent?.id;
			if (resolver.cardOfSession(sessionId) === void 0) throw new Error("当前会话没有关联的任务卡片");
			await resolver.mergeResolved(sessionId);
			exec.concludeTurn();
			return { ok: true };
		}
	}));
}
//#endregion
//#region src/server/runner.ts
/**
* KanbanRunner: the host-side engine.
*  - WorkerPool: per-workspace single worker, global parallel cap from settings.
*  - RefinementRunner: creates the refinement session (cwd = project dir).
*  - PhaseRunner: git worktree bootstrap + one session per phase, same worktree.
*  - MergeRunner: pure-CLI auto-merge with an AI merge session on conflicts.
*/
const WORKTREES_REL = [".dsh", "worktrees"];
var KanbanRunner = class {
	ctx;
	store;
	settings;
	runningByWs = /* @__PURE__ */ new Map();
	slots = 0;
	pumpTimer;
	/** sessionId → cardId (sessions created for this kanban). */
	sessionCards = /* @__PURE__ */ new Map();
	/** sessionId → true once the scoped completion tool ran. */
	completed = /* @__PURE__ */ new Map();
	merging = /* @__PURE__ */ new Set();
	/** Retained agent handles (kept so ended sessions stay in the store/UI). */
	handles = /* @__PURE__ */ new Map();
	/** Whether startup recovery + session indexing ran (deferred until workspaces exist). */
	recovered = false;
	/** Agents that already got their scoped kanban tools (event idempotency). */
	toolScopedAgents = /* @__PURE__ */ new WeakSet();
	agentStartOff;
	constructor(ctx, store, settings) {
		this.ctx = ctx;
		this.store = store;
		this.settings = settings;
	}
	register(ctx) {
		this.ctx = ctx;
	}
	start() {
		this.pumpTimer = setInterval(() => {
			this.pump();
		}, 2500);
		this.agentStartOff = this.ctx.on("agent/session-start", (payload) => {
			this.onAgentSessionStart(payload.agent);
		});
	}
	stop() {
		if (this.pumpTimer !== void 0) clearInterval(this.pumpTimer);
		this.pumpTimer = void 0;
		if (this.agentStartOff !== void 0) {
			this.agentStartOff();
			this.agentStartOff = void 0;
		}
	}
	newSessionId() {
		return `session-${randomUUID()}`;
	}
	asUserMessage(text) {
		return createUserMessage({
			content: [{
				type: "text",
				text
			}],
			source: { kind: "user" }
		});
	}
	async workspaceList() {
		const ws = this.ctx.get("workspace") ?? this.ctx.get("workspaceRegistry");
		if (ws === void 0) return [];
		try {
			return ws.list();
		} catch {
			return [];
		}
	}
	cardOfSession(sessionId) {
		return sessionId === void 0 ? void 0 : this.sessionCards.get(sessionId);
	}
	async writePlan(cardId, plan) {
		await this.store.mutate(cardId, (card) => {
			card.plan = plan;
			card.phaseCount = plan.phases.length;
			card.status = "planned";
			card.error = void 0;
		});
	}
	async phaseComplete(sessionId, summary) {
		const cardId = this.sessionCards.get(sessionId);
		if (cardId === void 0) return "";
		this.completed.set(sessionId, true);
		let phaseId = "";
		await this.store.mutate(cardId, (card) => {
			const attempt = card.sessions.phases.find((a) => a.sessionId === sessionId);
			if (attempt !== void 0) {
				attempt.summary = summary;
				attempt.completedAt = Date.now();
				if (card.plan !== void 0 && card.plan.phases[attempt.phaseIndex] !== void 0) phaseId = card.plan.phases[attempt.phaseIndex].id;
			}
		});
		return phaseId;
	}
	async mergeResolved(sessionId) {
		if (this.sessionCards.get(sessionId) === void 0) return;
		this.completed.set(sessionId, true);
	}
	toolResolver() {
		return {
			cardOfSession: (sid) => this.cardOfSession(sid),
			writePlan: (cardId, plan) => this.writePlan(cardId, plan),
			phaseComplete: (sid, summary) => this.phaseComplete(sid, summary),
			mergeResolved: (sid) => this.mergeResolved(sid)
		};
	}
	async recoverInterrupted() {
		for (const ws of await this.workspaceList()) {
			const cards = await this.store.list(ws.path);
			for (const c of cards) if (c.status === "running" || c.status === "refining" || c.status === "merging") {
				const stage = c.status === "running" ? "running" : c.status === "merging" ? "completed" : "demand";
				await this.store.mutate(c.id, (card) => {
					card.status = "error";
					card.error = {
						kind: "interrupted",
						stage,
						message: "服务重启导致会话中断，请点击重试继续",
						at: Date.now()
					};
				}, ws.path);
			}
		}
	}
	/**
	* Rebuild sessionId → cardId from the task store. Runs once the workspace
	* registry is available (see pump), so kanban sessions resumed after a
	* restart still resolve their card.
	*/
	async indexSessions() {
		for (const ws of await this.workspaceList()) {
			const cards = await this.store.list(ws.path);
			for (const card of cards) this.mapCardSessions(card.id, card);
		}
	}
	mapCardSessions(cardId, card) {
		for (const sid of card.sessions.refinement) this.sessionCards.set(sid, cardId);
		for (const attempt of card.sessions.phases) this.sessionCards.set(attempt.sessionId, cardId);
		for (const sid of card.sessions.merge) this.sessionCards.set(sid, cardId);
	}
	/** Fallback lookup when a session starts before indexSessions ran. */
	async lookupCardOfSession(sessionId) {
		for (const ws of await this.workspaceList()) {
			const cards = await this.store.list(ws.path);
			for (const card of cards) if (card.sessions.refinement.includes(sessionId) || card.sessions.phases.some((a) => a.sessionId === sessionId) || card.sessions.merge.includes(sessionId)) {
				this.mapCardSessions(card.id, card);
				return card.id;
			}
		}
	}
	/**
	* The single place kanban tools get registered. `agent/session-start` fires
	* for BOTH `agents.create` (startup) and `agents.resume` (host re-open after
	* a restart), so a resumed refinement/phase/merge session keeps its scoped
	* tools. Idempotent per agent object; non-kanban sessions are skipped.
	*/
	async onAgentSessionStart(agent) {
		if (agent === void 0 || agent.id === void 0 || agent.ctx === void 0) return;
		if (this.toolScopedAgents.has(agent)) return;
		let cardId = this.sessionCards.get(agent.id);
		if (cardId === void 0) cardId = await this.lookupCardOfSession(agent.id);
		if (cardId === void 0) return;
		this.sessionCards.set(agent.id, cardId);
		try {
			registerKanbanTools(agent.ctx, this.toolResolver());
			this.toolScopedAgents.add(agent);
		} catch (error) {
			console.error("[task-kanban] register kanban tools for " + agent.id + " failed:", String(error));
		}
	}
	async listCards(workspacePath) {
		return this.store.list(workspacePath);
	}
	async createTask(input) {
		const parsed = parseSkillGesture(input.requirement);
		const skill = input.skill !== void 0 && input.skill !== "" ? input.skill : parsed.skill;
		const requirement = skill !== void 0 ? parsed.requirement : input.requirement.trim();
		const card = await this.store.create({
			workspacePath: input.workspacePath,
			requirement,
			model: input.model,
			provider: input.provider,
			...skill !== void 0 ? { skill } : {},
			status: "refining"
		});
		await this.ensureGitignoreDsh(input.workspacePath);
		this.runRefinement(card.id, input.workspacePath);
		return card;
	}
	async moveTask(cardId, toLane) {
		const card = await this.findCard(cardId);
		if (card === void 0) return {
			ok: false,
			message: "卡片不存在"
		};
		if (toLane === "queue") {
			if (card.status === "running" || card.status === "refining" || card.status === "merging") {
				if (card.status === "running") {
					await this.requestStop(cardId);
					return { ok: true };
				}
				return {
					ok: false,
					message: "细化/合并中的卡片不能拖回队列"
				};
			}
			if (card.status !== "planned") return {
				ok: false,
				message: "只有已规划（有实现计划）的卡片才能进入队列"
			};
			await this.store.mutate(cardId, (c) => {
				c.status = "queued";
				c.queuedAt = Date.now();
				c.error = void 0;
			}, card.workspacePath);
			this.pump();
			return { ok: true };
		}
		if (toLane === "demand") {
			if (card.status !== "queued") return {
				ok: false,
				message: "只有队列中的卡片可以拖回需求区"
			};
			await this.store.mutate(cardId, (c) => {
				c.status = "planned";
				c.queuedAt = void 0;
				c.error = void 0;
			}, card.workspacePath);
			return { ok: true };
		}
		return {
			ok: false,
			message: "目标泳道不接受拖拽"
		};
	}
	async stopTask(cardId) {
		const card = await this.findCard(cardId);
		if (card === void 0) return {
			ok: false,
			message: "卡片不存在"
		};
		if (card.status !== "running" && card.status !== "merging") return {
			ok: false,
			message: "只有运行中的卡片可以停止"
		};
		if (card.status === "merging") return {
			ok: false,
			message: "合并流程中不能停止"
		};
		await this.requestStop(cardId);
		return { ok: true };
	}
	async retryTask(cardId) {
		const card = await this.findCard(cardId);
		if (card === void 0) return {
			ok: false,
			message: "卡片不存在"
		};
		if (card.status !== "error") return {
			ok: false,
			message: "只有错误状态的卡片可以重试"
		};
		const kind = card.error?.kind;
		if (kind === "refine_failed" || kind === "interrupted" && card.error?.stage === "demand") {
			await this.store.mutate(cardId, (c) => {
				c.status = "refining";
				c.error = void 0;
			}, card.workspacePath);
			this.runRefinement(cardId, card.workspacePath);
			return { ok: true };
		}
		if (kind === "merge_failed" || kind === "interrupted" && card.error?.stage === "completed") {
			await this.store.mutate(cardId, (c) => {
				c.status = "completed";
				c.error = void 0;
			}, card.workspacePath);
			this.runMerge(cardId, card.workspacePath);
			return { ok: true };
		}
		await this.store.mutate(cardId, (c) => {
			c.status = "queued";
			c.queuedAt = Date.now();
			c.error = void 0;
		}, card.workspacePath);
		this.pump();
		return { ok: true };
	}
	async deleteTask(cardId) {
		const card = await this.findCard(cardId);
		if (card === void 0) return {
			ok: false,
			message: "卡片不存在"
		};
		if (card.status === "running" || card.status === "refining" || card.status === "merging") return {
			ok: false,
			message: "运行中的卡片必须先停止才能删除"
		};
		if (card.gitMode && card.worktreePath !== void 0) {
			await runGit(card.workspacePath, [
				"worktree",
				"remove",
				"--force",
				card.worktreePath
			]);
			if (card.branch !== void 0) await runGit(card.workspacePath, [
				"branch",
				"-D",
				card.branch
			]);
		}
		for (const sid of card.sessions.refinement) this.sessionCards.delete(sid);
		for (const a of card.sessions.phases) this.sessionCards.delete(a.sessionId);
		for (const sid of card.sessions.merge) this.sessionCards.delete(sid);
		await this.store.remove(card.workspacePath, cardId);
		return { ok: true };
	}
	async findCard(cardId) {
		for (const ws of await this.workspaceList()) {
			const card = await this.store.get(ws.path, cardId);
			if (card !== void 0) return card;
		}
	}
	maxParallel() {
		return this.settings.get().maxParallelWorkers;
	}
	async pump() {
		if (!this.recovered) {
			if ((await this.workspaceList()).length > 0) {
				this.recovered = true;
				try {
					await this.recoverInterrupted();
				} catch (error) {
					console.error("[task-kanban] recoverInterrupted failed:", String(error));
				}
				try {
					await this.indexSessions();
				} catch (error) {
					console.error("[task-kanban] indexSessions failed:", String(error));
				}
			}
		}
		if (this.slots >= this.maxParallel()) return;
		const workspaces = await this.workspaceList();
		for (const ws of workspaces) {
			if (this.slots >= this.maxParallel()) return;
			if (this.runningByWs.has(ws.path)) continue;
			const next = (await this.store.list(ws.path)).filter((c) => c.status === "queued").sort((a, b) => (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt))[0];
			if (next === void 0) continue;
			this.slots += 1;
			const entry = {
				cardId: next.id,
				workspacePath: ws.path,
				stopped: false,
				cancel: null
			};
			this.runningByWs.set(ws.path, entry);
			this.runCard(ws.path, next, entry).finally(() => {
				this.slots -= 1;
				this.runningByWs.delete(ws.path);
				this.pump();
			});
		}
	}
	async requestStop(cardId) {
		for (const entry of this.runningByWs.values()) if (entry.cardId === cardId) {
			entry.stopped = true;
			entry.cancel?.();
			return;
		}
	}
	async fail(cardId, kind, message, stage) {
		await this.store.mutate(cardId, (card) => {
			card.status = "error";
			card.error = {
				kind,
				message,
				at: Date.now(),
				...stage !== void 0 ? { stage } : {}
			};
		});
	}
	async runRefinement(cardId, wsPath) {
		const card = await this.store.get(wsPath, cardId);
		if (card === void 0) return;
		const route = await this.modelRoute(cardId, wsPath);
		const sessionId = this.newSessionId();
		this.sessionCards.set(sessionId, cardId);
		await this.store.mutate(cardId, (c) => {
			c.status = "refining";
			c.error = void 0;
			c.sessions.refinement.push(sessionId);
		}, wsPath);
		try {
			const handle = await this.createAgent(sessionId, wsPath, route);
			this.keepHandle(cardId, handle);
			await this.attachRefinementSession(wsPath, sessionId);
			const skill = card.skill !== void 0 ? await loadCardSkill(this.ctx, card.skill, wsPath, handle.agent) : void 0;
			if (card.skill !== void 0 && skill === void 0) {
				await this.fail(cardId, "refine_failed", `Skill "${card.skill}" 不存在或不可用于用户调用，请检查后重试`, "demand");
				return;
			}
			if (skill !== void 0) handle.agent.inject(skillInvocationMessage(skill));
			const interactive = skill !== void 0;
			handle.agent.followup(this.asUserMessage(interactive ? interactiveRefinementPrompt(card.requirement, wsPath) : refinementPrompt(card.requirement, wsPath)));
			await this.driveRefinement(cardId, wsPath, sessionId, handle, interactive);
		} catch (error) {
			console.error("[task-kanban] refinement create/drive failed:", String(error));
			await this.fail(cardId, "refine_failed", `细化会话失败: ${String(error)}`, "demand");
		}
	}
	/**
	* Drive the refinement session to a terminal card state. Non-interactive
	* cards follow the original contract: the agent finishes one turn and must
	* have written the plan. Interactive cards (created with a refinement
	* skill) may ask the user clarifying questions — the session is explicit
	* and visible in the workspace chat, so the runner waits for each reply
	* instead of failing, and only settles when the plan is written or the
	* session errors out.
	*/
	async driveRefinement(cardId, wsPath, sessionId, handle, interactive) {
		while (true) {
			const reply = this.waitForUserReply(sessionId);
			const settlement = this.waitForCardSettlement(cardId, wsPath);
			await handle.agent.whenIdle();
			const fresh = await this.store.get(wsPath, cardId);
			if (fresh === void 0 || fresh.status !== "refining") {
				reply.dispose();
				settlement.dispose();
				return;
			}
			if (!interactive) {
				reply.dispose();
				settlement.dispose();
				try {
					const tail = handle.agent.session.events.slice(-10).map((e) => ({
						type: e.type,
						...e.data !== void 0 ? { data: JSON.stringify(e.data).slice(0, 600) } : {}
					}));
					console.error("[task-kanban] refinement session tail:", JSON.stringify(tail, null, 1));
				} catch (error) {
					console.error("[task-kanban] could not read session events:", String(error));
				}
				await this.fail(cardId, "refine_failed", "细化会话结束但未通过 kanban_write_plan 写回计划", "demand");
				return;
			}
			await Promise.race([reply.promise, settlement.promise]);
			reply.dispose();
			settlement.dispose();
		}
	}
	/**
	* A promise resolving when the card stops being 'refining' (planned,
	* failed, or gone), plus a disposer stopping the polling interval.
	*/
	waitForCardSettlement(cardId, wsPath) {
		let resolve;
		const promise = new Promise((res) => {
			resolve = res;
		});
		const timer = setInterval(async () => {
			const fresh = await this.store.get(wsPath, cardId);
			if (fresh === void 0 || fresh.status !== "refining") {
				clearInterval(timer);
				resolve();
			}
		}, 1e3);
		timer.unref?.();
		return {
			promise,
			dispose: () => clearInterval(timer)
		};
	}
	/**
	* A promise resolving when a NEW human message enters the given session,
	* plus a disposer detaching the listener. Messages injected by plugins with
	* non-`user` sources (such as our skill-invocation instructions) never
	* resolve it — only real human replies drive the interactive refinement.
	*/
	waitForUserReply(sessionId) {
		let settle;
		const promise = new Promise((resolve) => {
			settle = resolve;
		});
		const listener = (session, event) => {
			if (session.id !== sessionId) return;
			if (event.type !== "user/message") return;
			if (("source" in event.data ? event.data.source : void 0)?.kind === "user") settle();
		};
		const detach = this.ctx.on("session/event", listener);
		const dispose = () => {
			if (typeof detach === "function") detach();
		};
		return {
			promise,
			dispose
		};
	}
	async createAgent(sessionId, cwd, route) {
		const agentOptions = route.provider !== void 0 && route.model !== void 0 && route.model !== "" ? {
			provider: route.provider,
			model: route.model
		} : void 0;
		return this.ctx.agents.create({
			sessionId,
			meta: { cwd },
			...agentOptions !== void 0 ? { agentOptions } : {},
			setup: async (agentCtx) => {
				const agentPresets = agentCtx.get("agentPresets");
				if (agentPresets !== void 0) await agentPresets.mount(agentCtx, "standard");
				else throw new Error("@fonlan/dsh-task-kanban: agent-presets service is not mounted");
			}
		});
	}
	keepHandle(cardId, handle) {
		const list = this.handles.get(cardId) ?? [];
		list.push(handle);
		this.handles.set(cardId, list);
	}
	/**
	* Account the refinement session to its host workspace so it shows in that
	* workspace's session list. The session's cwd IS the workspace root, so the
	* registry's strict `cwd === workspace.path` check passes. Best-effort only:
	* an unregistered workspace (or a failing registry) must not break the card.
	*/
	async attachRefinementSession(workspacePath, sessionId) {
		const registry = this.attachRegistry();
		if (registry === void 0) return;
		try {
			const workspace = await registry.resolveByPath(workspacePath);
			if (workspace !== void 0) await workspace.attachSession(sessionId);
		} catch (error) {
			console.error("[task-kanban] attach refinement session to workspace failed:", String(error));
		}
	}
	/** The host workspace registry, whichever service name carries it. */
	attachRegistry() {
		for (const name of ["workspaceRegistry", "workspace"]) {
			const candidate = this.ctx.get(name);
			if (candidate !== void 0 && typeof candidate.resolveByPath === "function") return candidate;
		}
	}
	/** Resolve the provider+model route for an agent (both are required). */
	async modelRoute(cardId, wsPath) {
		const card = await this.store.get(wsPath, cardId);
		if (card === void 0) return {};
		if (card.model !== "" && card.provider !== void 0 && card.provider !== "") return {
			provider: card.provider,
			model: card.model
		};
		if (card.model !== "") {
			const fallback = this.settings.defaultModelRoute();
			return fallback.provider !== void 0 ? {
				provider: fallback.provider,
				model: card.model
			} : { model: card.model };
		}
		const userDefault = this.settings.get().defaultModel;
		if (userDefault !== "") {
			const fallback = this.settings.defaultModelRoute();
			return fallback.provider !== void 0 ? {
				provider: fallback.provider,
				model: userDefault
			} : { model: userDefault };
		}
		return this.settings.defaultModelRoute();
	}
	async runCard(wsPath, card, entry) {
		await this.store.mutate(card.id, (c) => {
			if (c.status === "queued") {
				c.status = "running";
				c.error = void 0;
			}
		}, wsPath);
		const gitMode = await isGitRepo(wsPath);
		await this.store.mutate(card.id, (c) => {
			c.gitMode = gitMode;
		}, wsPath);
		if (gitMode) {
			const fresh = await this.store.get(wsPath, card.id);
			if (fresh === void 0) return;
			if (fresh.worktreePath === void 0 || fresh.branch === void 0 || fresh.baseRef === void 0) {
				const base = await detectBaseRef(wsPath);
				if (base === void 0) {
					await this.fail(card.id, "no_base_branch", "项目没有 main 或 master 分支，无法创建 worktree", "running");
					return;
				}
				const branch = `kanban/${card.id.slice(0, 8)}`;
				const wt = join(wsPath, ...WORKTREES_REL, card.id);
				await this.store.mutate(card.id, (c) => {
					c.gitMode = true;
				}, wsPath);
				const result = await runGit(wsPath, [
					"worktree",
					"add",
					"-b",
					branch,
					wt,
					base
				]);
				if (result.code !== 0) {
					await this.fail(card.id, "worktree_failed", `创建 worktree 失败: ${result.stderr}`, "running");
					return;
				}
				const baseSha = await revParse(wsPath, base);
				await this.store.mutate(card.id, (c) => {
					c.worktreePath = wt;
					c.branch = branch;
					c.baseRef = base;
					c.baseSha = baseSha ?? void 0;
				}, wsPath);
			}
		}
		const current = await this.store.get(wsPath, card.id);
		if (current === void 0 || current.plan === void 0 || current.plan.phases.length === 0) {
			await this.fail(card.id, "phase_failed", "卡片没有实现计划", "running");
			return;
		}
		const plan = current.plan;
		const workdir = current.worktreePath ?? wsPath;
		let phaseIndex = current.currentPhase;
		while (phaseIndex < plan.phases.length) {
			if (entry.stopped) {
				await this.store.mutate(card.id, (c) => {
					c.status = "queued";
					c.queuedAt = Date.now();
					c.stoppedAt = Date.now();
					c.currentPhase = phaseIndex;
					c.error = void 0;
				}, wsPath);
				return;
			}
			if (!await this.runPhase(card.id, wsPath, workdir, plan, phaseIndex, entry)) return;
			phaseIndex = (await this.store.get(wsPath, card.id))?.currentPhase ?? phaseIndex;
		}
		if (gitMode) {
			await this.store.mutate(card.id, (c) => {
				c.status = "completed";
			}, wsPath);
			if (await this.runMerge(card.id, wsPath)) await this.store.mutate(card.id, (c) => {
				c.status = "merged";
				c.error = void 0;
			}, wsPath);
		} else await this.store.mutate(card.id, (c) => {
			c.status = "merged";
			c.error = void 0;
		}, wsPath);
	}
	async runPhase(cardId, wsPath, workdir, plan, phaseIndex, entry) {
		const phase = plan.phases[phaseIndex];
		const sessionId = this.newSessionId();
		this.sessionCards.set(sessionId, cardId);
		await this.store.mutate(cardId, (c) => {
			c.status = "running";
			c.error = void 0;
			c.sessions.phases.push({
				phaseIndex,
				sessionId,
				startedAt: Date.now()
			});
		}, wsPath);
		const route = await this.modelRoute(cardId, wsPath);
		try {
			const handle = await this.createAgent(sessionId, workdir, route);
			this.keepHandle(cardId, handle);
			entry.cancel = () => handle.agent.cancel({ kind: "user" });
			handle.agent.followup(this.asUserMessage(phasePrompt({
				...await this.store.get(wsPath, cardId) ?? { plan },
				plan
			}, phaseIndex, workdir)));
			await handle.agent.whenIdle();
			if (entry.stopped) {
				await this.store.mutate(cardId, (c) => {
					c.status = "queued";
					c.queuedAt = Date.now();
					c.stoppedAt = Date.now();
					c.currentPhase = phaseIndex;
					c.error = void 0;
				}, wsPath);
				return false;
			}
			const done = this.completed.get(sessionId) === true;
			this.completed.delete(sessionId);
			if (!done) {
				await this.fail(cardId, "phase_failed", `phase ${phase.id} 的会话未调用 kanban_phase_complete 就结束`, "running");
				return false;
			}
			await this.store.mutate(cardId, (c) => {
				c.currentPhase = phaseIndex + 1;
			}, wsPath);
			return true;
		} catch (error) {
			await this.fail(cardId, "phase_failed", `运行 phase ${phase.id} 失败: ${String(error)}`, "running");
			return false;
		}
	}
	async resolveConflictsIn(cardId, wsPath, workdir, opts = {}) {
		const conflicts = await unmergedPaths(workdir);
		if (conflicts === "") return true;
		if (!await this.runMergeSession(cardId, wsPath, workdir, conflicts)) return false;
		const add = await runGit(workdir, ["add", "-A"]);
		if (add.code !== 0) {
			await this.fail(cardId, "merge_failed", `git add 失败: ${add.stderr}`, "completed");
			return false;
		}
		const stillUnmerged = await unmergedPaths(workdir);
		if (stillUnmerged !== "") {
			await this.fail(cardId, "merge_failed", "合并会话后仍有未解决的冲突: " + stillUnmerged, "completed");
			return false;
		}
		const leftover = await this.verifyConflictMarkers(workdir, conflicts.split("\n"));
		if (leftover.length > 0) {
			await this.fail(cardId, "merge_failed", "合并会话后仍有冲突标记残留: " + leftover.join(", "), "completed");
			return false;
		}
		if (opts.keepUnstaged === true) await runGit(workdir, [
			"restore",
			"--staged",
			"."
		]);
		return true;
	}
	/** Check resolved files for leftover conflict markers. */
	async verifyConflictMarkers(dir, files) {
		const leftover = [];
		for (const f of files) {
			if (f.trim() === "") continue;
			try {
				if ((await readFile(join(dir, f), "utf8")).split("\n").some((l) => /^(<<<<<<<|=======|>>>>>>>)/.test(l))) leftover.push(f);
			} catch {}
		}
		return leftover;
	}
	async runMerge(cardId, wsPath) {
		if (this.merging.has(cardId)) return true;
		this.merging.add(cardId);
		try {
			const ok = await this.mergeCard(cardId, wsPath);
			if (ok) await this.store.mutate(cardId, (c) => {
				c.status = "merged";
				c.error = void 0;
			}, wsPath);
			return ok;
		} finally {
			this.merging.delete(cardId);
		}
	}
	async mergeCard(cardId, wsPath) {
		const card = await this.store.get(wsPath, cardId);
		if (card === void 0 || card.worktreePath === void 0 || card.branch === void 0 || card.baseRef === void 0) {
			await this.fail(cardId, "merge_failed", "缺少 worktree/分支信息，无法合并", "completed");
			return false;
		}
		const wt = card.worktreePath;
		const branch = card.branch;
		const base = card.baseRef;
		const step = card.merge?.step ?? "prepare";
		const stashMsg = `kanban-merge-${cardId.slice(0, 8)}`;
		await this.store.mutate(cardId, (c) => {
			c.status = "merging";
		}, wsPath);
		if (step === "prepare") {
			const cb = await currentBranch(wsPath);
			if (cb !== base) {
				await this.fail(cardId, "merge_failed", `项目当前分支是 ${cb ?? "?"}，不是 ${base}，请先切回`, "completed");
				return false;
			}
			let stashed = false;
			if (!await hasStashMessage(wsPath, stashMsg) && await isTreeDirty(wsPath)) {
				const r = await runGit(wsPath, [
					"stash",
					"push",
					"-m",
					stashMsg
				]);
				if (r.code !== 0) {
					await this.fail(cardId, "merge_failed", `stash 工作区改动失败: ${r.stderr}`, "completed");
					return false;
				}
				stashed = true;
			}
			await this.store.mutate(cardId, (c) => {
				c.merge = {
					step: "wt-merge",
					stashApplied: stashed
				};
			}, wsPath);
			return this.mergeCard(cardId, wsPath);
		}
		if (step === "wt-merge") {
			if (await unmergedPaths(wt) !== "") {
				if (!await this.resolveConflictsIn(cardId, wsPath, wt)) return false;
				const add = await runGit(wt, ["add", "-A"]);
				if (add.code !== 0) {
					await this.fail(cardId, "merge_failed", `git add 失败: ${add.stderr}`, "completed");
					return false;
				}
				const commit = await runGit(wt, [
					"commit",
					"-m",
					`kanban: 合并 ${base} 到 ${branch}（任务 ${cardId.slice(0, 8)}）`
				]);
				if (commit.code !== 0) {
					await this.fail(cardId, "merge_failed", `提交冲突解决结果失败: ${commit.stderr}`, "completed");
					return false;
				}
			} else {
				const wtStatus = await runGit(wt, ["status", "--porcelain"]);
				if (wtStatus.code === 0 && wtStatus.stdout.trim() !== "") {
					const add = await runGit(wt, ["add", "-A"]);
					if (add.code !== 0) {
						await this.fail(cardId, "merge_failed", `git add 失败: ${add.stderr}`, "completed");
						return false;
					}
					const commit = await runGit(wt, [
						"commit",
						"-m",
						`kanban: phase 实现成果（任务 ${cardId.slice(0, 8)}）`
					]);
					if (commit.code !== 0) {
						await this.fail(cardId, "merge_failed", `提交 phase 成果失败: ${commit.stderr}`, "completed");
						return false;
					}
				}
				const r = await runGit(wt, [
					"merge",
					base,
					"--no-edit"
				]);
				if (r.code !== 0) {
					if (await unmergedPaths(wt) !== "") {
						if (!await this.resolveConflictsIn(cardId, wsPath, wt)) return false;
						const add = await runGit(wt, ["add", "-A"]);
						if (add.code !== 0) {
							await this.fail(cardId, "merge_failed", `git add 失败: ${add.stderr}`, "completed");
							return false;
						}
						const commit = await runGit(wt, [
							"commit",
							"-m",
							`kanban: 合并 ${base} 到 ${branch}（任务 ${cardId.slice(0, 8)}）`
						]);
						if (commit.code !== 0) {
							await this.fail(cardId, "merge_failed", `提交冲突解决结果失败: ${commit.stderr}`, "completed");
							return false;
						}
					} else {
						await this.fail(cardId, "merge_failed", `worktree 合入 ${base} 失败: ${r.stderr}`, "completed");
						return false;
					}
				}
			}
			await this.store.mutate(cardId, (c) => {
				c.merge = {
					step: "ws-merge",
					stashApplied: c.merge?.stashApplied ?? false
				};
			}, wsPath);
			return this.mergeCard(cardId, wsPath);
		}
		if (step === "ws-merge") {
			const r = await runGit(wsPath, [
				"merge",
				branch,
				"--no-edit"
			]);
			let mergeCommit = await revParse(wsPath, "HEAD");
			if (r.code !== 0) {
				if (await unmergedPaths(wsPath) !== "") {
					if (!await this.resolveConflictsIn(cardId, wsPath, wsPath)) return false;
					const add = await runGit(wsPath, ["add", "-A"]);
					if (add.code !== 0) {
						await this.fail(cardId, "merge_failed", `git add 失败: ${add.stderr}`, "completed");
						return false;
					}
					const commit = await runGit(wsPath, [
						"commit",
						"--no-edit",
						"-m",
						`kanban: 合并 ${branch} 到 ${base}（任务 ${cardId.slice(0, 8)}）`
					]);
					if (commit.code !== 0) {
						await this.fail(cardId, "merge_failed", `提交合并失败: ${commit.stderr}`, "completed");
						return false;
					}
					mergeCommit = await revParse(wsPath, "HEAD");
				} else {
					await this.fail(cardId, "merge_failed", `合入主分支失败: ${r.stderr}`, "completed");
					return false;
				}
			}
			await this.store.mutate(cardId, (c) => {
				c.merge = {
					step: "pop",
					stashApplied: c.merge?.stashApplied ?? false,
					mergeCommit
				};
			}, wsPath);
			return this.mergeCard(cardId, wsPath);
		}
		if (step === "pop") {
			if (await hasStashMessage(wsPath, stashMsg)) {
				const r = await runGit(wsPath, ["stash", "pop"]);
				if (r.code !== 0) {
					if (await unmergedPaths(wsPath) !== "") {
						if (!await this.resolveConflictsIn(cardId, wsPath, wsPath, { keepUnstaged: true })) return false;
						const check = await runGit(wsPath, ["diff", "--check"]);
						if (check.code !== 0) {
							await this.fail(cardId, "merge_failed", `stash pop 冲突解决后仍有残留问题: ${check.stderr}`, "completed");
							return false;
						}
						await runGit(wsPath, ["stash", "drop"]);
					} else {
						await this.fail(cardId, "merge_failed", `stash pop 失败: ${r.stderr}`, "completed");
						return false;
					}
				}
			}
			await this.store.mutate(cardId, (c) => {
				c.merge = {
					step: "cleanup",
					stashApplied: false,
					mergeCommit: c.merge?.mergeCommit
				};
			}, wsPath);
			return this.mergeCard(cardId, wsPath);
		}
		await runGit(wsPath, [
			"worktree",
			"remove",
			"--force",
			wt
		]);
		if (card.branch !== void 0) await runGit(wsPath, [
			"branch",
			"-D",
			card.branch
		]);
		if (await hasStashMessage(wsPath, stashMsg)) await runGit(wsPath, ["stash", "drop"]);
		await this.store.mutate(cardId, (c) => {
			c.worktreePath = void 0;
			c.merge = {
				step: "cleanup",
				stashApplied: false,
				mergeCommit: c.merge?.mergeCommit
			};
		}, wsPath);
		return true;
	}
	async runMergeSession(cardId, wsPath, workdir, conflicts) {
		const sessionId = this.newSessionId();
		this.sessionCards.set(sessionId, cardId);
		await this.store.mutate(cardId, (c) => {
			c.sessions.merge.push(sessionId);
		}, wsPath);
		const route = await this.modelRoute(cardId, wsPath);
		try {
			const handle = await this.createAgent(sessionId, workdir, route);
			this.keepHandle(cardId, handle);
			handle.agent.followup(this.asUserMessage(mergePrompt(workdir, conflicts)));
			await handle.agent.whenIdle();
			const done = this.completed.get(sessionId) === true;
			this.completed.delete(sessionId);
			if (!done) {
				try {
					const tail = handle.agent.session.events.slice(-6).map((e) => ({
						type: e.type,
						...e.data !== void 0 ? { data: JSON.stringify(e.data).slice(0, 500) } : {}
					}));
					console.error("[task-kanban] merge session tail:", JSON.stringify(tail, null, 1));
				} catch (error) {
					console.error("[task-kanban] merge session events unreadable:", String(error));
				}
				await this.fail(cardId, "merge_failed", "合并会话结束但未调用 kanban_merge_resolved 声明解决", "completed");
			}
			return done;
		} catch (error) {
			await this.fail(cardId, "merge_failed", `合并会话失败: ${String(error)}`, "completed");
			return false;
		}
	}
	async ensureGitignoreDsh(workspacePath) {
		if (!await isGitRepo(workspacePath)) return;
		const ignorePath = join(workspacePath, ".gitignore");
		let content = "";
		try {
			content = await readFile(ignorePath, "utf8");
		} catch {
			content = "";
		}
		if (content.includes(".dsh")) return;
		const extra = (content === "" ? "" : "\n") + "# @fonlan/dsh-task-kanban\n.dsh/\n";
		try {
			await appendFile(ignorePath, extra);
		} catch {}
	}
};
//#endregion
//#region src/server/models.ts
/** Available models from every registered LLM provider (advisory catalog). */
async function listModels(ctx) {
	const llm = ctx.get("llm");
	if (llm === void 0) return [];
	const out = [];
	for (const provider of llm.listProviders()) try {
		const models = await llm.listModels(provider.id);
		for (const m of models) out.push({
			provider: provider.id,
			id: m.id,
			name: m.name ?? m.id
		});
	} catch {}
	return out;
}
//#endregion
//#region src/server/rpc.ts
const API_PREFIX = "/plugins/@fonlan/dsh-task-kanban/api";
function header(headers, name) {
	const value = headers[name];
	return typeof value === "string" ? value : void 0;
}
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function isTrustedApiRequest(req, trustedHosts) {
	const host = header(req.headers, "host");
	if (host === void 0) return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (!isLoopbackHostname(hostUrl.hostname) && !trustedHosts.includes(hostUrl.host) && !trustedHosts.includes(hostUrl.hostname)) {
		if (!trustedHosts.some((entry) => entry === hostUrl.hostname || entry === hostUrl.host)) return false;
	}
	if (header(req.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(req.headers, "origin");
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
function trustedHostsOf(ctx) {
	for (const entry of ctx.get("loader")?.entries?.() ?? []) if (entry.options?.name === "connection") return entry.options.config?.trustedHosts ?? [];
	return [];
}
function writeJson(res, body) {
	res.writeHead(200, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(body));
}
function writeError(res, code, message, status = 400) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify({
		ok: false,
		error: {
			code,
			message
		}
	}));
}
function requireString(value, name) {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} 不能为空`);
	return value;
}
async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.trim() === "") return {};
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
function registerApiRoutes(ctx, runner, settings) {
	const fence = (req) => isTrustedApiRequest(req, trustedHostsOf(ctx));
	const disposers = [];
	const route = (name, handler) => {
		disposers.push(ctx.webServer.register({
			kind: "prefix",
			path: `${API_PREFIX}/${name}`,
			handler: async (req, res) => {
				if (!fence(req)) {
					writeError(res, "forbidden", "forbidden", 403);
					return;
				}
				if (req.method !== "POST" && req.method !== "GET") {
					writeError(res, "method", "method not allowed", 405);
					return;
				}
				const payload = await readJsonBody(req);
				try {
					writeJson(res, {
						ok: true,
						value: await handler(payload)
					});
				} catch (error) {
					writeError(res, "error", error instanceof Error ? error.message : String(error));
				}
			}
		}));
	};
	route("list", async (p) => runner.listCards(requireString(p.workspacePath, "workspacePath")));
	route("create", async (p) => {
		const workspacePath = requireString(p.workspacePath, "workspacePath");
		const requirement = requireString(p.requirement, "requirement");
		const model = typeof p.model === "string" ? p.model : "";
		const provider = typeof p.provider === "string" ? p.provider : void 0;
		const skill = typeof p.skill === "string" && p.skill !== "" ? p.skill : void 0;
		return runner.createTask({
			workspacePath,
			requirement,
			model,
			provider,
			...skill !== void 0 ? { skill } : {}
		});
	});
	route("move", async (p) => {
		const cardId = requireString(p.cardId, "cardId");
		const toLane = p.toLane;
		if (![
			"demand",
			"queue",
			"running",
			"completed",
			"merged"
		].includes(toLane)) throw new Error("无效的目标泳道");
		return runner.moveTask(cardId, toLane);
	});
	route("stop", async (p) => runner.stopTask(requireString(p.cardId, "cardId")));
	route("retry", async (p) => runner.retryTask(requireString(p.cardId, "cardId")));
	route("remove", async (p) => runner.deleteTask(requireString(p.cardId, "cardId")));
	route("settings.get", async () => settings.get());
	route("settings.set", async (p) => {
		const patch = {};
		if (typeof p.maxParallelWorkers === "number") patch.maxParallelWorkers = p.maxParallelWorkers;
		if (typeof p.defaultModel === "string") patch.defaultModel = p.defaultModel;
		await settings.update(patch);
		return settings.get();
	});
	route("models.list", async () => listModels(ctx));
	return () => {
		for (const d of disposers) d();
	};
}
//#endregion
//#region src/index.ts
const name = "@fonlan/dsh-task-kanban";
const inject = [
	"webServer",
	"agents",
	"skills"
];
const Config = z.object({});
function apply(ctx, _config) {
	const settings = registerSettings(ctx);
	const runner = new KanbanRunner(ctx, new TaskStore(), settings);
	ctx.effect(() => {
		runner.recoverInterrupted();
		runner.start();
		return () => runner.stop();
	}, "task-kanban: runner lifecycle");
	ctx.effect(() => registerApiRoutes(ctx, runner, settings), "task-kanban: api routes");
}
//#endregion
export { Config, apply, inject, name };
