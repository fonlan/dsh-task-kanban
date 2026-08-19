/**
 * KanbanRunner: the host-side engine.
 *  - WorkerPool: per-workspace single worker, global parallel cap from settings.
 *  - RefinementRunner: creates the refinement session (cwd = project dir).
 *  - PhaseRunner: git worktree bootstrap + one session per phase, same worktree.
 *  - MergeRunner: pure-CLI auto-merge with an AI merge session on conflicts.
 */
import { randomUUID } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { installModelSelection, type AgentHandle, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { KanbanCard, ErrorKind, KanbanSessionKind, Lane, Plan } from '../shared/card.js'
import type { TaskStore } from './task-store.js'
import type { KanbanSettingsFace } from './settings.js'
import { currentBranch, detectBaseRef, hasStashMessage, isGitRepo, isTreeDirty, revParse, runGit, unmergedPaths } from './git.js'
import { interactiveRefinementPrompt, mergePrompt, phasePrompt, refinementPrompt } from './prompts.js'
import { loadCardSkill, parseSkillGesture, skillInvocationMessage } from './skills.js'
import { registerKanbanTools, type KanbanToolResolver } from './tools.js'
import type {} from '@deepseek-ai/dsh-agent-presets'

const WORKTREES_REL = ['.dsh', 'worktrees']

interface WorkspaceEntry {
  title: string
  path: string
}

/** Minimal structural face of the optional host `sessionTitle` service. */
interface SessionTitleFace {
  get(session: Session): { source: { kind: string } } | undefined
  rename(session: Session, title: string): unknown
}

interface RunningEntry {
  cardId: string
  workspacePath: string
  stopped: boolean
  cancel: (() => void) | null
}

export class KanbanRunner implements KanbanToolResolver {
  private ctx: Context
  private store: TaskStore
  private settings: KanbanSettingsFace
  private runningByWs = new Map<string, RunningEntry>()
  private slots = 0
  private pumpTimer: NodeJS.Timeout | undefined
  /** sessionId → cardId (sessions created for this kanban). */
  private sessionCards = new Map<string, string>()
  /** sessionId → true once the scoped completion tool ran. */
  private completed = new Map<string, boolean>()
  private merging = new Set<string>()
  /** Retained agent handles (kept so ended sessions stay in the store/UI). */
  private handles = new Map<string, AgentHandle[]>()
  /** Whether startup recovery + session indexing ran (deferred until workspaces exist). */
  private recovered = false
  /** Agents that already got their scoped kanban tools (event idempotency). */
  private toolScopedAgents = new WeakSet<object>()
  private agentStartOff: (() => void) | undefined

  constructor(ctx: Context, store: TaskStore, settings: KanbanSettingsFace) {
    this.ctx = ctx
    this.store = store
    this.settings = settings
  }

  register(ctx: Context): void {
    this.ctx = ctx
  }

  start(): void {
    this.pumpTimer = setInterval(() => { void this.pump() }, 2500)
    // `agent/session-start` fires for BOTH agents.create (startup) and
    // agents.resume (host re-open after a restart). Kanban tools are scoped
    // per agent, so a resumed refinement/phase/merge session would otherwise
    // lose them — register there instead of only in createAgent's setup.
    this.agentStartOff = this.ctx.on('agent/session-start', (payload: { agent?: { id?: string; ctx?: Context } }) => {
      void this.onAgentSessionStart(payload.agent)
    })
  }

  stop(): void {
    if (this.pumpTimer !== undefined) clearInterval(this.pumpTimer)
    this.pumpTimer = undefined
    if (this.agentStartOff !== undefined) {
      this.agentStartOff()
      this.agentStartOff = undefined
    }
  }

  private newSessionId(): SessionId {
    return `session-${randomUUID()}` as SessionId
  }

  private asUserMessage(text: string) {
    return createUserMessage({
      content: [{ type: 'text', text }],
      // kind must be 'user' (not 'plugin'): the session-title service and the
      // conversation UI only treat `source.kind === 'user'` messages as human
      // input — with 'plugin' the kanban sessions never get an LLM title.
      source: { kind: 'user' },
    })
  }

  private async workspaceList(): Promise<WorkspaceEntry[]> {
    const ws = (this.ctx.get('workspace') ?? this.ctx.get('workspaceRegistry')) as { list(): WorkspaceEntry[] } | undefined
    if (ws === undefined) return []
    try {
      return ws.list()
    } catch {
      return []
    }
  }

  // ── KanbanToolResolver ────────────────────────────────────────────────────

  cardOfSession(sessionId?: string): string | undefined {
    return sessionId === undefined ? undefined : this.sessionCards.get(sessionId)
  }

  async writePlan(cardId: string, plan: Plan): Promise<void> {
    await this.store.mutate(cardId, (card) => {
      card.plan = plan
      card.phaseCount = plan.phases.length
      card.status = 'planned'
      card.error = undefined
    })
  }

  async phaseComplete(sessionId: string, summary: string): Promise<string> {
    const cardId = this.sessionCards.get(sessionId)
    if (cardId === undefined) return ''
    this.completed.set(sessionId, true)
    let phaseId = ''
    await this.store.mutate(cardId, (card) => {
      const attempt = card.sessions.phases.find((a) => a.sessionId === sessionId)
      if (attempt !== undefined) {
        attempt.summary = summary
        attempt.completedAt = Date.now()
        if (card.plan !== undefined && card.plan.phases[attempt.phaseIndex] !== undefined) {
          phaseId = card.plan.phases[attempt.phaseIndex].id
        }
      }
    })
    return phaseId
  }

  async mergeResolved(sessionId: string): Promise<void> {
    const cardId = this.sessionCards.get(sessionId)
    if (cardId === undefined) return
    this.completed.set(sessionId, true)
  }

  private toolResolver(): KanbanToolResolver {
    return {
      cardOfSession: (sid) => this.cardOfSession(sid),
      writePlan: (cardId, plan) => this.writePlan(cardId, plan),
      phaseComplete: (sid, summary) => this.phaseComplete(sid, summary),
      mergeResolved: (sid) => this.mergeResolved(sid),
    }
  }

  // ── Restart recovery ──────────────────────────────────────────────────────

  async recoverInterrupted(): Promise<void> {
    for (const ws of await this.workspaceList()) {
      const cards = await this.store.list(ws.path)
      for (const c of cards) {
        if (c.status === 'running' || c.status === 'refining' || c.status === 'merging') {
          const stage: Lane = c.status === 'running' ? 'running' : c.status === 'merging' ? 'completed' : 'demand'
          await this.store.mutate(c.id, (card) => {
            card.status = 'error'
            card.error = { kind: 'interrupted', stage, message: '服务重启导致会话中断，请点击重试继续', at: Date.now() }
          }, ws.path)
        }
      }
    }
  }

  /**
   * Rebuild sessionId → cardId from the task store. Runs once the workspace
   * registry is available (see pump), so kanban sessions resumed after a
   * restart still resolve their card.
   */
  private async indexSessions(): Promise<void> {
    for (const ws of await this.workspaceList()) {
      const cards = await this.store.list(ws.path)
      for (const card of cards) this.mapCardSessions(card.id, card)
    }
  }

  private mapCardSessions(cardId: string, card: KanbanCard): void {
    for (const sid of card.sessions.refinement) this.sessionCards.set(sid, cardId)
    for (const attempt of card.sessions.phases) this.sessionCards.set(attempt.sessionId, cardId)
    for (const sid of card.sessions.merge) this.sessionCards.set(sid, cardId)
  }

  /** Fallback lookup when a session starts before indexSessions ran. */
  private async lookupCardOfSession(sessionId: string): Promise<string | undefined> {
    for (const ws of await this.workspaceList()) {
      const cards = await this.store.list(ws.path)
      for (const card of cards) {
        const hit =
          card.sessions.refinement.includes(sessionId) ||
          card.sessions.phases.some((a) => a.sessionId === sessionId) ||
          card.sessions.merge.includes(sessionId)
        if (hit) {
          this.mapCardSessions(card.id, card)
          return card.id
        }
      }
    }
    return undefined
  }

  /**
   * The single place kanban tools get registered. `agent/session-start` fires
   * for BOTH `agents.create` (startup) and `agents.resume` (host re-open after
   * a restart), so a resumed refinement/phase/merge session keeps its scoped
   * tools. Idempotent per agent object; non-kanban sessions are skipped.
   */
  private async onAgentSessionStart(agent: { id?: string; ctx?: Context } | undefined): Promise<void> {
    if (agent === undefined || agent.id === undefined || agent.ctx === undefined) return
    if (this.toolScopedAgents.has(agent)) return
    let cardId = this.sessionCards.get(agent.id)
    if (cardId === undefined) cardId = await this.lookupCardOfSession(agent.id)
    if (cardId === undefined) return
    this.sessionCards.set(agent.id, cardId)
    try {
      registerKanbanTools(agent.ctx, this.toolResolver())
      this.toolScopedAgents.add(agent)
    } catch (error) {
      console.error('[task-kanban] register kanban tools for ' + agent.id + ' failed:', String(error))
    }
    // Historical phase sessions reopened after their work ended (completion,
    // interruption, host restart) keep a deterministic "plan · phase N" title
    // when the host LLM title never landed. Fresh sessions are skipped here:
    // their card is live ('running') and the LLM title may still be pending.
    try {
      await this.settleResumedPhaseTitle(agent.id, cardId)
    } catch (error) {
      console.error('[task-kanban] settle resumed phase title failed:', String(error))
    }
  }

  // ── Card operations (RPC entry points) ────────────────────────────────────

  async listCards(workspacePath: string): Promise<KanbanCard[]> {
    return this.store.list(workspacePath)
  }

  async createTask(input: { workspacePath: string; requirement: string; model: string; provider?: string; skill?: string }): Promise<KanbanCard> {
    // A leading /skill-name gesture chooses the refinement skill; it is
    // stripped from the stored requirement so the prose the model sees stays
    // clean. The explicit `skill` field (client-parsed) wins when both are
    // present.
    const parsed = parseSkillGesture(input.requirement)
    const skill = input.skill !== undefined && input.skill !== '' ? input.skill : parsed.skill
    const requirement = skill !== undefined ? parsed.requirement : input.requirement.trim()
    const card = await this.store.create({
      workspacePath: input.workspacePath,
      requirement,
      model: input.model,
      provider: input.provider,
      ...(skill !== undefined ? { skill } : {}),
      status: 'refining',
    })
    await this.ensureGitignoreDsh(input.workspacePath)
    void this.runRefinement(card.id, input.workspacePath)
    return card
  }

  async moveTask(cardId: string, toLane: Lane): Promise<{ ok: boolean; message?: string }> {
    const card = await this.findCard(cardId)
    if (card === undefined) return { ok: false, message: '卡片不存在' }
    if (toLane === 'queue') {
      if (card.status === 'running' || card.status === 'refining' || card.status === 'merging') {
        // stop semantics: running card dropped back to queue
        if (card.status === 'running') {
          await this.requestStop(cardId)
          return { ok: true }
        }
        return { ok: false, message: '细化/合并中的卡片不能拖回队列' }
      }
      if (card.status !== 'planned') {
        return { ok: false, message: '只有已规划（有实现计划）的卡片才能进入队列' }
      }
      await this.store.mutate(cardId, (c) => {
        c.status = 'queued'
        c.queuedAt = Date.now()
        c.error = undefined
      }, card.workspacePath)
      void this.pump()
      return { ok: true }
    }
    if (toLane === 'demand') {
      if (card.status !== 'queued') return { ok: false, message: '只有队列中的卡片可以拖回需求区' }
      await this.store.mutate(cardId, (c) => {
        c.status = 'planned'
        c.queuedAt = undefined
        c.error = undefined
      }, card.workspacePath)
      return { ok: true }
    }
    return { ok: false, message: '目标泳道不接受拖拽' }
  }

  async stopTask(cardId: string): Promise<{ ok: boolean; message?: string }> {
    const card = await this.findCard(cardId)
    if (card === undefined) return { ok: false, message: '卡片不存在' }
    if (card.status !== 'running' && card.status !== 'merging') {
      return { ok: false, message: '只有运行中的卡片可以停止' }
    }
    if (card.status === 'merging') return { ok: false, message: '合并流程中不能停止' }
    await this.requestStop(cardId)
    return { ok: true }
  }

  async retryTask(cardId: string): Promise<{ ok: boolean; message?: string }> {
    const card = await this.findCard(cardId)
    if (card === undefined) return { ok: false, message: '卡片不存在' }
    if (card.status !== 'error') return { ok: false, message: '只有错误状态的卡片可以重试' }
    const kind = card.error?.kind
    if (kind === 'refine_failed' || (kind === 'interrupted' && card.error?.stage === 'demand')) {
      await this.store.mutate(cardId, (c) => { c.status = 'refining'; c.error = undefined }, card.workspacePath)
      void this.runRefinement(cardId, card.workspacePath)
      return { ok: true }
    }
    if (kind === 'merge_failed' || (kind === 'interrupted' && card.error?.stage === 'completed')) {
      await this.store.mutate(cardId, (c) => { c.status = 'completed'; c.error = undefined }, card.workspacePath)
      void this.runMerge(cardId, card.workspacePath)
      return { ok: true }
    }
    // phase_failed / interrupted(running) / no_base_branch / worktree_failed / create_failed: back to queue
    await this.store.mutate(cardId, (c) => {
      c.status = 'queued'
      c.queuedAt = Date.now()
      c.error = undefined
    }, card.workspacePath)
    void this.pump()
    return { ok: true }
  }

  async deleteTask(cardId: string): Promise<{ ok: boolean; message?: string }> {
    const card = await this.findCard(cardId)
    if (card === undefined) return { ok: false, message: '卡片不存在' }
    if (card.status === 'running' || card.status === 'refining' || card.status === 'merging') {
      return { ok: false, message: '运行中的卡片必须先停止才能删除' }
    }
    if (card.gitMode && card.worktreePath !== undefined) {
      await runGit(card.workspacePath, ['worktree', 'remove', '--force', card.worktreePath])
      if (card.branch !== undefined) await runGit(card.workspacePath, ['branch', '-D', card.branch])
    }
    for (const sid of card.sessions.refinement) this.sessionCards.delete(sid)
    for (const a of card.sessions.phases) this.sessionCards.delete(a.sessionId)
    for (const sid of card.sessions.merge) this.sessionCards.delete(sid)
    await this.store.remove(card.workspacePath, cardId)
    return { ok: true }
  }

  private async findCard(cardId: string): Promise<KanbanCard | undefined> {
    for (const ws of await this.workspaceList()) {
      const card = await this.store.get(ws.path, cardId)
      if (card !== undefined) return card
    }
    return undefined
  }

  // ── Worker pool ───────────────────────────────────────────────────────────

  private maxParallel(): number {
    return this.settings.get().maxParallelWorkers
  }

  async pump(): Promise<void> {
    // Recovery and session indexing need the workspace registry, which may
    // not be populated when the plugin first applies (the old code silently
    // no-opped and left interrupted cards stuck in refining). Retry on the
    // pump tick until the first workspace appears.
    if (!this.recovered) {
      const ws = await this.workspaceList()
      if (ws.length > 0) {
        this.recovered = true
        try {
          await this.recoverInterrupted()
        } catch (error) {
          console.error('[task-kanban] recoverInterrupted failed:', String(error))
        }
        try {
          await this.indexSessions()
        } catch (error) {
          console.error('[task-kanban] indexSessions failed:', String(error))
        }
      }
    }
    if (this.slots >= this.maxParallel()) return
    const workspaces = await this.workspaceList()
    for (const ws of workspaces) {
      if (this.slots >= this.maxParallel()) return
      if (this.runningByWs.has(ws.path)) continue
      const cards = await this.store.list(ws.path)
      const queued = cards
        .filter((c) => c.status === 'queued')
        .sort((a, b) => (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt))
      const next = queued[0]
      if (next === undefined) continue
      this.slots += 1
      const entry: RunningEntry = { cardId: next.id, workspacePath: ws.path, stopped: false, cancel: null }
      this.runningByWs.set(ws.path, entry)
      void this.runCard(ws.path, next, entry).finally(() => {
        this.slots -= 1
        this.runningByWs.delete(ws.path)
        void this.pump()
      })
    }
  }

  private async requestStop(cardId: string): Promise<void> {
    for (const entry of this.runningByWs.values()) {
      if (entry.cardId === cardId) {
        entry.stopped = true
        entry.cancel?.()
        return
      }
    }
  }

  private async fail(cardId: string, kind: ErrorKind, message: string, stage?: Lane): Promise<void> {
    await this.store.mutate(cardId, (card) => {
      card.status = 'error'
      card.error = { kind, message, at: Date.now(), ...(stage !== undefined ? { stage } : {}) }
    })
  }

  // ── Refinement ────────────────────────────────────────────────────────────

  private async runRefinement(cardId: string, wsPath: string): Promise<void> {
    const card = await this.store.get(wsPath, cardId)
    if (card === undefined) return
    const route = await this.modelRoute(cardId, wsPath, 'refine')
    const sessionId = this.newSessionId()
    this.sessionCards.set(sessionId, cardId)
    await this.store.mutate(cardId, (c) => {
      c.status = 'refining'
      c.error = undefined
      c.sessions.refinement.push(sessionId)
    }, wsPath)
    try {
      const handle = await this.createAgent(sessionId, wsPath, route, 'refine')
      this.keepHandle(cardId, handle)
      await this.attachRefinementSession(wsPath, sessionId)
      // The agent scope is the layer where preset skill providers live
      // (skill-filesystem + tool-skill); load the card's skill through it.
      const skill = card.skill !== undefined
        ? await loadCardSkill(this.ctx, card.skill, wsPath, handle.agent)
        : undefined
      if (card.skill !== undefined && skill === undefined) {
        await this.fail(cardId, 'refine_failed', `Skill "${card.skill}" 不存在或不可用于用户调用，请检查后重试`, 'demand')
        return
      }
      if (skill !== undefined) {
        // Queue the canonical <skill_content> block as injected context for
        // the same pre-step that claims the refinement prompt (instructions
        // form with the harness's skill-invocation source).
        handle.agent.inject(skillInvocationMessage(skill))
      }
      const interactive = skill !== undefined
      handle.agent.followup(this.asUserMessage(
        interactive ? interactiveRefinementPrompt(card.requirement, wsPath) : refinementPrompt(card.requirement, wsPath),
      ))
      await this.driveRefinement(cardId, wsPath, sessionId, handle, interactive)
    } catch (error) {
      console.error('[task-kanban] refinement create/drive failed:', String(error))
      await this.fail(cardId, 'refine_failed', `细化会话失败: ${String(error)}`, 'demand')
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
  private async driveRefinement(
    cardId: string,
    wsPath: string,
    sessionId: SessionId,
    handle: AgentHandle,
    interactive: boolean,
  ): Promise<void> {
    while (true) {
      // Arm the user-reply signal BEFORE waiting so no reply can slip past.
      const reply = this.waitForUserReply(sessionId)
      const settlement = this.waitForCardSettlement(cardId, wsPath)
      await handle.agent.whenIdle()
      const fresh = await this.store.get(wsPath, cardId)
      if (fresh === undefined || fresh.status !== 'refining') {
        reply.dispose()
        settlement.dispose()
        return
      }
      if (!interactive) {
        reply.dispose()
        settlement.dispose()
        // debug: log the session tail regardless
        try {
          const events = handle.agent.session.events
          const tail = events.slice(-10).map((e) => ({
            type: e.type,
            ...(e.data !== undefined ? { data: JSON.stringify(e.data).slice(0, 600) } : {}),
          }))
          console.error('[task-kanban] refinement session tail:', JSON.stringify(tail, null, 1))
        } catch (error) {
          console.error('[task-kanban] could not read session events:', String(error))
        }
        await this.fail(cardId, 'refine_failed', '细化会话结束但未通过 kanban_write_plan 写回计划', 'demand')
        return
      }
      // Interactive: the agent went idle without writing the plan — it asked
      // the user something and is waiting for a reply. Wait for the next
      // human message, then drive the agent through it and re-check. Also
      // escape if the card is externally settled (writePlan/fail) without a
      // message, so a stuck session cannot pin the card in 'refining'.
      await Promise.race([reply.promise, settlement.promise])
      reply.dispose()
      settlement.dispose()
    }
  }

  /**
   * A promise resolving when the card stops being 'refining' (planned,
   * failed, or gone), plus a disposer stopping the polling interval.
   */
  private waitForCardSettlement(cardId: string, wsPath: string): { promise: Promise<void>; dispose(): void } {
    let resolve!: () => void
    const promise = new Promise<void>((res) => { resolve = res })
    const timer = setInterval(async () => {
      const fresh = await this.store.get(wsPath, cardId)
      if (fresh === undefined || fresh.status !== 'refining') {
        clearInterval(timer)
        resolve()
      }
    }, 1000)
    timer.unref?.()
    return { promise, dispose: () => clearInterval(timer) }
  }

  /**
   * A promise resolving when a NEW human message enters the given session,
   * plus a disposer detaching the listener. Messages injected by plugins with
   * non-`user` sources (such as our skill-invocation instructions) never
   * resolve it — only real human replies drive the interactive refinement.
   */
  private waitForUserReply(sessionId: SessionId): { promise: Promise<void>; dispose(): void } {
    let settle!: () => void
    const promise = new Promise<void>((resolve) => { settle = resolve })
    const listener = (session: Session, event: SessionEvent): void => {
      if (session.id !== sessionId) return
      if (event.type !== 'user/message') return
      const source = ('source' in event.data ? (event.data as { source?: { kind?: string } }).source : undefined)
      if (source?.kind === 'user') settle()
    }
    const detach = this.ctx.on('session/event', listener)
    const dispose = (): void => { if (typeof detach === 'function') detach() }
    return { promise, dispose }
  }

  /**
   * Create one kanban session agent. `kind` decides the per-session preset:
   * refine/phase use their settings default (falling back to the roster's
   * default preset when unset), merge keeps the historical 'standard' preset.
   * When the kind defaults configure a reasoning effort, an
   * `installModelSelection` ref couples the provider/model + effort into every
   * prompt assembly and model request. Without a configured effort no
   * selection is installed: `agentOptions` carries the route and the loop
   * materializes the model's own default effort — the historical behavior.
   */
  private async createAgent(
    sessionId: SessionId,
    cwd: string,
    route: { provider?: string; model?: string; reasoningEffort?: string },
    kind: KanbanSessionKind,
  ) {
    const agentOptions =
      route.provider !== undefined && route.model !== undefined && route.model !== ''
        ? { provider: route.provider, model: route.model }
        : undefined
    const selectionRef: ModelSelectionRef = {
      current:
        route.provider !== undefined && route.model !== undefined && route.model !== ''
          ? {
              provider: route.provider,
              model: route.model,
              ...(route.reasoningEffort !== undefined && route.reasoningEffort !== ''
                ? { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }
                : {}),
            }
          : undefined,
      assembled: undefined,
    }
    // Resolve the preset id BEFORE creation so the session header records the
    // exact composition it runs under (a resumed kanban session then rebuilds
    // the same preset instead of the deployment default).
    let presetId: string | undefined
    const presets = this.ctx.get('agentPresets') as
      | { resolve(id?: string): Promise<{ id: string }> }
      | undefined
    if (presets !== undefined) {
      const requested = kind === 'merge' ? 'standard' : this.settings.sessionDefaults(kind).preset
      const resolved = await presets.resolve(requested === '' ? undefined : requested)
      presetId = resolved.id
    }
    return this.ctx.agents.create({
      sessionId,
      meta: { cwd, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
      ...(agentOptions !== undefined ? { agentOptions } : {}),
      // Kanban tools are NOT registered here: `agent/session-start` (see
      // start()) fires for both create and resume, keeping them available
      // even when the host re-opens a persisted kanban session.
      setup: async (agentCtx) => {
        const agentPresets = agentCtx.get('agentPresets') as
          | { mount(agentCtx: unknown, id?: string): Promise<unknown> }
          | undefined
        if (agentPresets !== undefined) {
          await agentPresets.mount(agentCtx, presetId)
        } else {
          throw new Error('@fonlan/dsh-task-kanban: agent-presets service is not mounted')
        }
        if (selectionRef.current !== undefined && selectionRef.current.reasoningEffort !== undefined) {
          installModelSelection(agentCtx, selectionRef)
        }
      },
    })
  }

  private keepHandle(cardId: string, handle: AgentHandle): void {
    const list = this.handles.get(cardId) ?? []
    list.push(handle)
    this.handles.set(cardId, list)
  }

  /**
   * Account the refinement session to its host workspace so it shows in that
   * workspace's session list. The session's cwd IS the workspace root, so the
   * registry's strict `cwd === workspace.path` check passes. Best-effort only:
   * an unregistered workspace (or a failing registry) must not break the card.
   */
  private async attachRefinementSession(workspacePath: string, sessionId: SessionId): Promise<void> {
    const registry = this.attachRegistry()
    if (registry === undefined) return
    try {
      const workspace = await registry.resolveByPath(workspacePath)
      if (workspace !== undefined) await workspace.attachSession(sessionId)
    } catch (error) {
      console.error('[task-kanban] attach refinement session to workspace failed:', String(error))
    }
  }

  /** The host workspace registry, whichever service name carries it. */
  private attachRegistry(): { resolveByPath(path: string): Promise<{ attachSession(id: string): Promise<unknown> } | undefined> } | undefined {
    for (const name of ['workspaceRegistry', 'workspace']) {
      const candidate = this.ctx.get(name) as { resolveByPath?: unknown } | undefined
      if (candidate !== undefined && typeof candidate.resolveByPath === 'function') {
        return candidate as { resolveByPath(path: string): Promise<{ attachSession(id: string): Promise<unknown> } | undefined> }
      }
    }
    return undefined
  }

  /**
   * Resolve the provider+model route for an agent (both are required), plus
   * the per-kind reasoning effort. Precedence per kind:
   *   1. the card's explicit model (chosen at creation) — wins for every kind;
   *   2. the session-kind defaults (refine/phase settings);
   *   3. the host `agent-default-model` route.
   * Merge sessions skip step 2 (no per-type defaults for them).
   */
  private async modelRoute(
    cardId: string,
    wsPath: string,
    kind: KanbanSessionKind,
  ): Promise<{ provider?: string; model?: string; reasoningEffort?: string }> {
    const card = await this.store.get(wsPath, cardId)
    if (card === undefined) return {}
    if (card.model !== '' && card.provider !== undefined && card.provider !== '') {
      return { provider: card.provider, model: card.model }
    }
    if (card.model !== '') {
      const fallback = this.settings.defaultModelRoute()
      return fallback.provider !== undefined ? { provider: fallback.provider, model: card.model } : { model: card.model }
    }
    const kindDefaults = this.settings.sessionDefaults(kind)
    if (kindDefaults.model !== '') {
      return {
        ...(kindDefaults.provider !== '' ? { provider: kindDefaults.provider } : {}),
        model: kindDefaults.model,
        ...(kindDefaults.reasoningEffort !== '' ? { reasoningEffort: kindDefaults.reasoningEffort } : {}),
      }
    }
    return this.settings.defaultModelRoute()
  }

  // ── Phase execution ───────────────────────────────────────────────────────

  private async runCard(wsPath: string, card: KanbanCard, entry: RunningEntry): Promise<void> {
    await this.store.mutate(card.id, (c) => {
      if (c.status === 'queued') {
        c.status = 'running'
        c.error = undefined
      }
    }, wsPath)

    const gitMode = await isGitRepo(wsPath)
    await this.store.mutate(card.id, (c) => { c.gitMode = gitMode }, wsPath)

    if (gitMode) {
      const fresh = await this.store.get(wsPath, card.id)
      if (fresh === undefined) return
      if (fresh.worktreePath === undefined || fresh.branch === undefined || fresh.baseRef === undefined) {
        const base = await detectBaseRef(wsPath)
        if (base === undefined) {
          await this.fail(card.id, 'no_base_branch', '项目没有 main 或 master 分支，无法创建 worktree', 'running')
          return
        }
        const branch = `kanban/${card.id.slice(0, 8)}`
        const wt = join(wsPath, ...WORKTREES_REL, card.id)
        await this.store.mutate(card.id, (c) => { c.gitMode = true }, wsPath)
        const result = await runGit(wsPath, ['worktree', 'add', '-b', branch, wt, base])
        if (result.code !== 0) {
          await this.fail(card.id, 'worktree_failed', `创建 worktree 失败: ${result.stderr}`, 'running')
          return
        }
        const baseSha = await revParse(wsPath, base)
        await this.store.mutate(card.id, (c) => {
          c.worktreePath = wt
          c.branch = branch
          c.baseRef = base
          c.baseSha = baseSha ?? undefined
        }, wsPath)
      }
    }

    const current = await this.store.get(wsPath, card.id)
    if (current === undefined || current.plan === undefined || current.plan.phases.length === 0) {
      await this.fail(card.id, 'phase_failed', '卡片没有实现计划', 'running')
      return
    }
    const plan = current.plan
    const workdir = current.worktreePath ?? wsPath
    let phaseIndex = current.currentPhase

    while (phaseIndex < plan.phases.length) {
      if (entry.stopped) {
        await this.store.mutate(card.id, (c) => {
          c.status = 'queued'
          c.queuedAt = Date.now()
          c.stoppedAt = Date.now()
          c.currentPhase = phaseIndex
          c.error = undefined
        }, wsPath)
        return
      }
      const ok = await this.runPhase(card.id, wsPath, workdir, plan, phaseIndex, entry)
      if (!ok) return
      const freshCard = await this.store.get(wsPath, card.id)
      phaseIndex = freshCard?.currentPhase ?? phaseIndex
    }

    if (gitMode) {
      await this.store.mutate(card.id, (c) => { c.status = 'completed' }, wsPath)
      const merged = await this.runMerge(card.id, wsPath)
      if (merged) {
        await this.store.mutate(card.id, (c) => { c.status = 'merged'; c.error = undefined }, wsPath)
      }
    } else {
      await this.store.mutate(card.id, (c) => { c.status = 'merged'; c.error = undefined }, wsPath)
    }
  }

  private async runPhase(
    cardId: string,
    wsPath: string,
    workdir: string,
    plan: Plan,
    phaseIndex: number,
    entry: RunningEntry,
  ): Promise<boolean> {
    const phase = plan.phases[phaseIndex]
    const sessionId = this.newSessionId()
    this.sessionCards.set(sessionId, cardId)
    await this.store.mutate(cardId, (c) => {
      c.status = 'running'
      c.error = undefined
      c.sessions.phases.push({ phaseIndex, sessionId, startedAt: Date.now() })
    }, wsPath)
    const route = await this.modelRoute(cardId, wsPath, 'phase')
    try {
      const handle = await this.createAgent(sessionId, workdir, route, 'phase')
      this.keepHandle(cardId, handle)
      entry.cancel = () => handle.agent.cancel({ kind: 'user' })
      handle.agent.followup(this.asUserMessage(phasePrompt({ ...(await this.store.get(wsPath, cardId)) ?? { plan } as KanbanCard, plan } as KanbanCard, phaseIndex, workdir)))
      await handle.agent.whenIdle()
      // Deterministic title fallback: keep the host LLM title when it landed
      // (provider-kind); otherwise rename to "{plan title} · phase N" so the
      // session never shows the raw prompt prefix in the sidebar.
      await this.settlePhaseTitle(sessionId, plan, phaseIndex)
      if (entry.stopped) {
        await this.store.mutate(cardId, (c) => {
          c.status = 'queued'
          c.queuedAt = Date.now()
          c.stoppedAt = Date.now()
          c.currentPhase = phaseIndex
          c.error = undefined
        }, wsPath)
        return false
      }
      const done = this.completed.get(sessionId) === true
      this.completed.delete(sessionId)
      if (!done) {
        await this.fail(cardId, 'phase_failed', `phase ${phase.id} 的会话未调用 kanban_phase_complete 就结束`, 'running')
        return false
      }
      await this.store.mutate(cardId, (c) => { c.currentPhase = phaseIndex + 1 }, wsPath)
      return true
    } catch (error) {
      await this.fail(cardId, 'phase_failed', `运行 phase ${phase.id} 失败: ${String(error)}`, 'running')
      return false
    }
  }

  /**
   * Deterministic title fallback for phase implementation sessions. The host
   * session-title service (`dsh-session-title-first-prompt-llm`) generates an
   * LLM title for every fresh non-fork session whose first user message is
   * human-kind; when it lands, `session/title` carries a `provider` source and
   * we keep it. Kanban sessions are routed through the `model-router` provider
   * by default and their LLM title call never settles there (observed: only
   * the deterministic prompt-prefix fallback "你是一个软件实现工程师。请…"
   * ever lands). Once the phase session is over — or a persisted session is
   * reopened — no LLM title is coming, so a still-`fallback` title is renamed
   * to "{plan title} · phase N": the display format requested as the fallback
   * when auto-generation is unavailable. Best-effort only: a missing title
   * service, session, or a rename failure must never break the card flow.
   */
  private async settlePhaseTitle(sessionId: SessionId, plan: Plan, phaseIndex: number): Promise<void> {
    const sessionTitle = this.ctx.get('sessionTitle') as SessionTitleFace | undefined
    if (sessionTitle === undefined) return
    const sessions = this.ctx.get('sessions') as { get(id: string): Session | undefined } | undefined
    const session = sessions?.get(sessionId)
    if (session === undefined) return
    const snapshot = sessionTitle.get(session)
    if (snapshot === undefined || snapshot.source.kind !== 'fallback') return
    const phase = plan.phases[phaseIndex]
    const base = plan.title.trim() !== '' ? plan.title : phase?.title ?? ''
    const title = `${base} · phase ${phaseIndex + 1}`
    try {
      sessionTitle.rename(session, title)
    } catch (error) {
      console.error('[task-kanban] settle phase session title failed:', String(error))
    }
  }

  /**
   * Title fallback for phase sessions that are reopened after their work
   * ended (completion, interruption, or a host restart). A live phase card is
   * skipped: its session may still be generating the LLM title.
   */
  private async settleResumedPhaseTitle(sessionId: string, cardId: string): Promise<void> {
    const card = await this.findCard(cardId)
    if (card === undefined || card.plan === undefined) return
    if (card.status === 'running' || card.status === 'refining' || card.status === 'merging') return
    const attempt = card.sessions.phases.find((a) => a.sessionId === sessionId)
    if (attempt === undefined) return
    await this.settlePhaseTitle(sessionId as SessionId, card.plan, attempt.phaseIndex)
  }

  private async resolveConflictsIn(
    cardId: string,
    wsPath: string,
    workdir: string,
    opts: { keepUnstaged?: boolean } = {},
  ): Promise<boolean> {
    const conflicts = await unmergedPaths(workdir)
    if (conflicts === '') return true
    const ok = await this.runMergeSession(cardId, wsPath, workdir, conflicts)
    if (!ok) return false
    // The AI resolves in the working tree only; the plugin stages the
    // resolution, which is also what clears the unmerged index entries.
    const add = await runGit(workdir, ['add', '-A'])
    if (add.code !== 0) {
      await this.fail(cardId, 'merge_failed', `git add 失败: ${add.stderr}`, 'completed')
      return false
    }
    const stillUnmerged = await unmergedPaths(workdir)
    if (stillUnmerged !== '') {
      await this.fail(cardId, 'merge_failed', '合并会话后仍有未解决的冲突: ' + stillUnmerged, 'completed')
      return false
    }
    const leftover = await this.verifyConflictMarkers(workdir, conflicts.split('\n'))
    if (leftover.length > 0) {
      await this.fail(cardId, 'merge_failed', '合并会话后仍有冲突标记残留: ' + leftover.join(', '), 'completed')
      return false
    }
    if (opts.keepUnstaged === true) {
      // stash-pop semantics: the user's changes stay uncommitted and unstaged
      await runGit(workdir, ['restore', '--staged', '.'])
    }
    return true
  }

  /** Check resolved files for leftover conflict markers. */
  private async verifyConflictMarkers(dir: string, files: string[]): Promise<string[]> {
    const leftover: string[] = []
    for (const f of files) {
      if (f.trim() === '') continue
      try {
        const text = await readFile(join(dir, f), 'utf8')
        if (text.split('\n').some((l) => /^(<<<<<<<|=======|>>>>>>>)/.test(l))) leftover.push(f)
      } catch {
        // file missing: nothing to check
      }
    }
    return leftover
  }

  // ── Merge ─────────────────────────────────────────────────────────────────

  async runMerge(cardId: string, wsPath: string): Promise<boolean> {
    if (this.merging.has(cardId)) return true
    this.merging.add(cardId)
    try {
      const ok = await this.mergeCard(cardId, wsPath)
      if (ok) {
        await this.store.mutate(cardId, (c) => { c.status = 'merged'; c.error = undefined }, wsPath)
      }
      return ok
    } finally {
      this.merging.delete(cardId)
    }
  }

  private async mergeCard(cardId: string, wsPath: string): Promise<boolean> {
    const card = await this.store.get(wsPath, cardId)
    if (card === undefined || card.worktreePath === undefined || card.branch === undefined || card.baseRef === undefined) {
      await this.fail(cardId, 'merge_failed', '缺少 worktree/分支信息，无法合并', 'completed')
      return false
    }
    const wt = card.worktreePath
    const branch = card.branch
    const base = card.baseRef
    const step = card.merge?.step ?? ('prepare' as const)
    const stashMsg = `kanban-merge-${cardId.slice(0, 8)}`
    await this.store.mutate(cardId, (c) => { c.status = 'merging' }, wsPath)

    if (step === 'prepare') {
      const cb = await currentBranch(wsPath)
      if (cb !== base) {
        await this.fail(cardId, 'merge_failed', `项目当前分支是 ${cb ?? '?'}，不是 ${base}，请先切回`, 'completed')
        return false
      }
      let stashed = false
      if (!(await hasStashMessage(wsPath, stashMsg)) && (await isTreeDirty(wsPath))) {
        const r = await runGit(wsPath, ['stash', 'push', '-m', stashMsg])
        if (r.code !== 0) {
          await this.fail(cardId, 'merge_failed', `stash 工作区改动失败: ${r.stderr}`, 'completed')
          return false
        }
        stashed = true
      }
      await this.store.mutate(cardId, (c) => { c.merge = { step: 'wt-merge', stashApplied: stashed } }, wsPath)
      return this.mergeCard(cardId, wsPath)
    }

    if (step === 'wt-merge') {
      const inProgress = (await unmergedPaths(wt)) !== ''
      if (inProgress) {
        // A previous attempt left the merge half-done (retry path): resolve
        // the pending conflicts before anything else.
        if (!(await this.resolveConflictsIn(cardId, wsPath, wt))) return false
        const add = await runGit(wt, ['add', '-A'])
        if (add.code !== 0) {
          await this.fail(cardId, 'merge_failed', `git add 失败: ${add.stderr}`, 'completed')
          return false
        }
        const commit = await runGit(wt, ['commit', '-m', `kanban: 合并 ${base} 到 ${branch}（任务 ${cardId.slice(0, 8)}）`])
        if (commit.code !== 0) {
          await this.fail(cardId, 'merge_failed', `提交冲突解决结果失败: ${commit.stderr}`, 'completed')
          return false
        }
      } else {
        // Phase sessions never commit (the plugin owns commits): fold their
        // work into a plugin-authored commit first, or `git merge` refuses on
        // a dirty tree.
        const wtStatus = await runGit(wt, ['status', '--porcelain'])
        if (wtStatus.code === 0 && wtStatus.stdout.trim() !== '') {
          const add = await runGit(wt, ['add', '-A'])
          if (add.code !== 0) {
            await this.fail(cardId, 'merge_failed', `git add 失败: ${add.stderr}`, 'completed')
            return false
          }
          const commit = await runGit(wt, ['commit', '-m', `kanban: phase 实现成果（任务 ${cardId.slice(0, 8)}）`])
          if (commit.code !== 0) {
            await this.fail(cardId, 'merge_failed', `提交 phase 成果失败: ${commit.stderr}`, 'completed')
            return false
          }
        }
        const r = await runGit(wt, ['merge', base, '--no-edit'])
        if (r.code !== 0) {
          const conflicts = await unmergedPaths(wt)
          if (conflicts !== '') {
            if (!(await this.resolveConflictsIn(cardId, wsPath, wt))) return false
            const add = await runGit(wt, ['add', '-A'])
            if (add.code !== 0) {
              await this.fail(cardId, 'merge_failed', `git add 失败: ${add.stderr}`, 'completed')
              return false
            }
            const commit = await runGit(wt, ['commit', '-m', `kanban: 合并 ${base} 到 ${branch}（任务 ${cardId.slice(0, 8)}）`])
            if (commit.code !== 0) {
              await this.fail(cardId, 'merge_failed', `提交冲突解决结果失败: ${commit.stderr}`, 'completed')
              return false
            }
          } else {
            await this.fail(cardId, 'merge_failed', `worktree 合入 ${base} 失败: ${r.stderr}`, 'completed')
            return false
          }
        }
      }
      await this.store.mutate(cardId, (c) => { c.merge = { step: 'ws-merge', stashApplied: c.merge?.stashApplied ?? false } }, wsPath)
      return this.mergeCard(cardId, wsPath)
    }

    if (step === 'ws-merge') {
      const r = await runGit(wsPath, ['merge', branch, '--no-edit'])
      let mergeCommit = await revParse(wsPath, 'HEAD')
      if (r.code !== 0) {
        const conflicts = await unmergedPaths(wsPath)
        if (conflicts !== '') {
          if (!(await this.resolveConflictsIn(cardId, wsPath, wsPath))) return false
          const add = await runGit(wsPath, ['add', '-A'])
          if (add.code !== 0) {
            await this.fail(cardId, 'merge_failed', `git add 失败: ${add.stderr}`, 'completed')
            return false
          }
          const commit = await runGit(wsPath, ['commit', '--no-edit', '-m', `kanban: 合并 ${branch} 到 ${base}（任务 ${cardId.slice(0, 8)}）`])
          if (commit.code !== 0) {
            await this.fail(cardId, 'merge_failed', `提交合并失败: ${commit.stderr}`, 'completed')
            return false
          }
          mergeCommit = await revParse(wsPath, 'HEAD')
        } else {
          await this.fail(cardId, 'merge_failed', `合入主分支失败: ${r.stderr}`, 'completed')
          return false
        }
      }
      await this.store.mutate(cardId, (c) => { c.merge = { step: 'pop', stashApplied: c.merge?.stashApplied ?? false, mergeCommit } }, wsPath)
      return this.mergeCard(cardId, wsPath)
    }

    if (step === 'pop') {
      if (await hasStashMessage(wsPath, stashMsg)) {
        const r = await runGit(wsPath, ['stash', 'pop'])
        if (r.code !== 0) {
          const conflicts = await unmergedPaths(wsPath)
          if (conflicts !== '') {
            if (!(await this.resolveConflictsIn(cardId, wsPath, wsPath, { keepUnstaged: true }))) return false
            const check = await runGit(wsPath, ['diff', '--check'])
            if (check.code !== 0) {
              await this.fail(cardId, 'merge_failed', `stash pop 冲突解决后仍有残留问题: ${check.stderr}`, 'completed')
              return false
            }
            await runGit(wsPath, ['stash', 'drop'])
          } else {
            await this.fail(cardId, 'merge_failed', `stash pop 失败: ${r.stderr}`, 'completed')
            return false
          }
        }
      }
      await this.store.mutate(cardId, (c) => {
        c.merge = { step: 'cleanup', stashApplied: false, mergeCommit: c.merge?.mergeCommit }
      }, wsPath)
      return this.mergeCard(cardId, wsPath)
    }

    // cleanup (final step, no resume needed after)
    await runGit(wsPath, ['worktree', 'remove', '--force', wt])
    if (card.branch !== undefined) await runGit(wsPath, ['branch', '-D', card.branch])
    if (await hasStashMessage(wsPath, stashMsg)) await runGit(wsPath, ['stash', 'drop'])
    await this.store.mutate(cardId, (c) => {
      c.worktreePath = undefined
      c.merge = { step: 'cleanup', stashApplied: false, mergeCommit: c.merge?.mergeCommit }
    }, wsPath)
    return true
  }

  private async runMergeSession(cardId: string, wsPath: string, workdir: string, conflicts: string): Promise<boolean> {
    const sessionId = this.newSessionId()
    this.sessionCards.set(sessionId, cardId)
    await this.store.mutate(cardId, (c) => { c.sessions.merge.push(sessionId) }, wsPath)
    const route = await this.modelRoute(cardId, wsPath, 'merge')
    try {
      const handle = await this.createAgent(sessionId, workdir, route, 'merge')
      this.keepHandle(cardId, handle)
      handle.agent.followup(this.asUserMessage(mergePrompt(workdir, conflicts)))
      await handle.agent.whenIdle()
      const done = this.completed.get(sessionId) === true
      this.completed.delete(sessionId)
      if (!done) {
        try {
          const events = handle.agent.session.events
          const tail = events.slice(-6).map((e) => ({
            type: e.type,
            ...(e.data !== undefined ? { data: JSON.stringify(e.data).slice(0, 500) } : {}),
          }))
          console.error('[task-kanban] merge session tail:', JSON.stringify(tail, null, 1))
        } catch (error) {
          console.error('[task-kanban] merge session events unreadable:', String(error))
        }
        await this.fail(cardId, 'merge_failed', '合并会话结束但未调用 kanban_merge_resolved 声明解决', 'completed')
      }
      return done
    } catch (error) {
      await this.fail(cardId, 'merge_failed', `合并会话失败: ${String(error)}`, 'completed')
      return false
    }
  }

  // ── .gitignore ────────────────────────────────────────────────────────────

  private async ensureGitignoreDsh(workspacePath: string): Promise<void> {
    if (!(await isGitRepo(workspacePath))) return
    const ignorePath = join(workspacePath, '.gitignore')
    let content = ''
    try {
      content = await readFile(ignorePath, 'utf8')
    } catch {
      content = ''
    }
    if (content.includes('.dsh')) return
    const extra = (content === '' ? '' : '\n') + '# @fonlan/dsh-task-kanban\n.dsh/\n'
    try {
      await appendFile(ignorePath, extra)
    } catch {
      // workspace not writable: non-fatal
    }
  }
}