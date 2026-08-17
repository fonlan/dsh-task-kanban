import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { KanbanRunner } from '../src/server/runner.js'
import type { KanbanCard } from '../src/shared/card.js'
import type { TaskStore } from '../src/server/task-store.js'
import type { KanbanSettingsFace } from '../src/server/settings.js'

const SID = 'session-04522e72-ca97-4b06-bf3e-c32d385a0a20' as SessionId
const OTHER_SID = 'session-other' as SessionId
const WS = '/tmp/kanban-ws'

/** A fake store holding one card in memory. */
function makeStore(initial: KanbanCard): TaskStore {
  let card: KanbanCard | undefined = initial
  return {
    get: async () => card,
    list: async () => (card === undefined ? [] : [card]),
    mutate: async (_id: string, fn: (c: KanbanCard) => void | Promise<void>) => {
      if (card !== undefined) {
        await fn(card)
        return card
      }
      return undefined
    },
  } as unknown as TaskStore
}

/** A fake event bus with an exposed workspace registry (used by indexSessions/lookup). */
function makeWorkspaceCtx(): { ctx: Context } {
  const listeners: Array<(session: Session, event: SessionEvent) => void> = []
  const ctx = {
    on: (_name: string, listener: (...args: unknown[]) => void) => {
      listeners.push(listener as (session: Session, event: SessionEvent) => void)
      return () => {
        const i = listeners.indexOf(listener as never)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    get: (name: string) => {
      if (name === 'workspace' || name === 'workspaceRegistry') {
        return { list: () => [{ title: 'ws', path: WS }] }
      }
      return undefined
    },
  } as unknown as Context
  return { ctx }
}

function makeRunner(ctx: Context, store: TaskStore): KanbanRunner {
  const settings = {
    get: () => ({ maxParallelWorkers: 1 }),
    defaultModelRoute: () => ({}),
  } as unknown as KanbanSettingsFace
  return new KanbanRunner(ctx, store, settings)
}

function card(status: KanbanCard['status']): KanbanCard {
  return {
    schemaVersion: 1,
    id: 'c1',
    workspacePath: WS,
    requirement: 'r',
    skill: 'grill-me',
    model: 'm',
    status,
    currentPhase: 0,
    phaseCount: 0,
    sessions: { refinement: [], phases: [], merge: [] },
    createdAt: 0,
  }
}

/** Fake agent ctx recording tools.register calls. */
function fakeAgent(id: SessionId, register: () => void) {
  return { id, ctx: { tools: { register } } }
}

const call = (runner: KanbanRunner, agent: unknown): Promise<void> =>
  (runner as unknown as { onAgentSessionStart(a: unknown): Promise<void> }).onAgentSessionStart(agent)

describe('KanbanRunner.onAgentSessionStart', () => {
  it('registers the kanban tools for a resumed kanban session (store lookup)', async () => {
    const store = makeStore(card('refining'))
    await store.mutate('c1', (c) => { c.sessions.refinement.push(SID) })
    const runner = makeRunner(makeWorkspaceCtx().ctx, store)
    let registered = 0
    await call(runner, fakeAgent(SID, () => { registered += 1 }))
    expect(registered).toBe(3)
    // The mapping must be recorded so cardOfSession resolves later.
    expect((runner as unknown as { sessionCards: Map<string, string> }).sessionCards.get(SID)).toBe('c1')
  })

  it('registers immediately when the mapping already exists (fresh create path)', async () => {
    const store = makeStore(card('refining'))
    const runner = makeRunner(makeWorkspaceCtx().ctx, store)
    ;(runner as unknown as { sessionCards: Map<string, string> }).sessionCards.set(SID, 'c1')
    let registered = 0
    await call(runner, fakeAgent(SID, () => { registered += 1 }))
    expect(registered).toBe(3)
  })

  it('skips sessions that do not belong to any kanban card', async () => {
    const store = makeStore(card('refining'))
    const runner = makeRunner(makeWorkspaceCtx().ctx, store)
    let registered = 0
    await call(runner, fakeAgent(OTHER_SID, () => { registered += 1 }))
    expect(registered).toBe(0)
    expect((runner as unknown as { sessionCards: Map<string, string> }).sessionCards.has(OTHER_SID)).toBe(false)
  })

  it('is idempotent per agent object (no duplicate tool registration)', async () => {
    const store = makeStore(card('refining'))
    await store.mutate('c1', (c) => { c.sessions.refinement.push(SID) })
    const runner = makeRunner(makeWorkspaceCtx().ctx, store)
    let registered = 0
    const agent = fakeAgent(SID, () => { registered += 1 })
    await call(runner, agent)
    await call(runner, agent)
    expect(registered).toBe(3)
  })
})

describe('KanbanRunner.indexSessions', () => {
  it('maps refinement, phase and merge session ids to their card', async () => {
    const store = makeStore(card('refining'))
    await store.mutate('c1', (c) => {
      c.sessions.refinement.push(SID)
      c.sessions.phases.push({ phaseIndex: 0, sessionId: 'session-phase' as SessionId, startedAt: 0 })
      c.sessions.merge.push('session-merge' as SessionId)
    })
    const runner = makeRunner(makeWorkspaceCtx().ctx, store)
    await (runner as unknown as { indexSessions(): Promise<void> }).indexSessions()
    const map = (runner as unknown as { sessionCards: Map<string, string> }).sessionCards
    expect(map.get(SID)).toBe('c1')
    expect(map.get('session-phase')).toBe('c1')
    expect(map.get('session-merge')).toBe('c1')
  })
})
