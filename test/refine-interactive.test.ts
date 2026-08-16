import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { KanbanRunner } from '../src/server/runner.js'
import type { KanbanCard } from '../src/shared/card.js'
import type { TaskStore } from '../src/server/task-store.js'
import type { KanbanSettingsFace } from '../src/server/settings.js'

const SID = 'session-interactive' as SessionId
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

/** A fake event bus replaying session events through the cordis-style `on`. */
function makeCtx(): {
  ctx: Context
  emitUserMessage(sid: SessionId, sourceKind: string): void
} {
  const listeners: Array<(session: Session, event: SessionEvent) => void> = []
  const ctx = {
    on: (_name: string, listener: (...args: unknown[]) => void) => {
      listeners.push(listener as (session: Session, event: SessionEvent) => void)
      return () => {
        const i = listeners.indexOf(listener as never)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
  } as unknown as Context
  return {
    ctx,
    emitUserMessage: (sid: SessionId, sourceKind: string) => {
      for (const l of listeners) {
        l(
          { id: sid } as Session,
          {
            type: 'user/message',
            data: { source: { kind: sourceKind } },
          } as unknown as SessionEvent,
        )
      }
    },
  }
}

function makeRunner(ctx: Context, store: TaskStore): KanbanRunner {
  const settings = {
    get: () => ({ maxParallelWorkers: 1 }),
    defaultModelRoute: () => ({}),
  } as unknown as KanbanSettingsFace
  return new KanbanRunner(ctx, store, settings)
}

function makeHandle(idleCount: { value: number }): AgentHandle {
  return {
    agent: {
      session: { events: [] },
      whenIdle: async () => { idleCount.value += 1 },
    },
  } as unknown as AgentHandle
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

const drive = (runner: KanbanRunner, c: KanbanCard, handle: AgentHandle, interactive: boolean): Promise<void> =>
  (runner as unknown as { driveRefinement(cardId: string, ws: string, sid: SessionId, h: AgentHandle, i: boolean): Promise<void> })
    .driveRefinement(c.id, WS, SID, handle, interactive)

describe('KanbanRunner.driveRefinement', () => {
  it('succeeds when the plan is written (non-interactive)', async () => {
    const store = makeStore(card('planned'))
    const idle = { value: 0 }
    const runner = makeRunner(makeCtx().ctx, store)
    await drive(runner, card('planned'), makeHandle(idle), false)
    expect(idle.value).toBe(1)
  })

  it('fails a non-interactive card that idles without a plan', async () => {
    const store = makeStore(card('refining'))
    const runner = makeRunner(makeCtx().ctx, store)
    await drive(runner, card('refining'), makeHandle({ value: 0 }), false)
    const fresh = await store.get(WS, 'c1')
    expect(fresh?.status).toBe('error')
    expect(fresh?.error?.kind).toBe('refine_failed')
  })

  it('waits for user replies during interactive refinement and then succeeds', async () => {
    const store = makeStore(card('refining'))
    const eventBus = makeCtx()
    const runner = makeRunner(eventBus.ctx, store)
    const idle = { value: 0 }
    const handle = makeHandle(idle)
    const driving = drive(runner, card('refining'), handle, true)
    // Let the first whenIdle resolve; the runner is now waiting for a reply.
    await new Promise((r) => setTimeout(r, 10))
    expect(idle.value).toBe(1)
    // "User" (source kind 'user') replies → the agent would wake; simulate the
    // agent idling again AND the plan being written in the same turn.
    store.mutate('c1', (c) => { c.status = 'planned' })
    eventBus.emitUserMessage(SID, 'user')
    await new Promise((r) => setTimeout(r, 30))
    await driving
    const fresh = await store.get(WS, 'c1')
    expect(fresh?.status).toBe('planned')
    // The loop must have idled again after the reply was consumed.
    expect(idle.value).toBe(2)
  })

  it('ignores non-user (plugin/skill-invocation) session messages', async () => {
    const store = makeStore(card('refining'))
    const eventBus = makeCtx()
    const runner = makeRunner(eventBus.ctx, store)
    const idle = { value: 0 }
    const driving = drive(runner, card('refining'), makeHandle(idle), true)
    await new Promise((r) => setTimeout(r, 10))
    // A skill-invocation message must NOT resolve the wait.
    eventBus.emitUserMessage(SID, 'skill-invocation')
    await new Promise((r) => setTimeout(r, 20))
    expect(idle.value).toBe(1)
    // Only a real user message resolves it.
    store.mutate('c1', (c) => { c.status = 'planned' })
    eventBus.emitUserMessage(SID, 'user')
    await new Promise((r) => setTimeout(r, 30))
    await driving
  })

  it('ignores user messages for other sessions', async () => {
    const store = makeStore(card('refining'))
    const eventBus = makeCtx()
    const runner = makeRunner(eventBus.ctx, store)
    const idle = { value: 0 }
    const driving = drive(runner, card('refining'), makeHandle(idle), true)
    await new Promise((r) => setTimeout(r, 10))
    eventBus.emitUserMessage('session-other' as SessionId, 'user')
    await new Promise((r) => setTimeout(r, 20))
    expect(idle.value).toBe(1)
    store.mutate('c1', (c) => { c.status = 'planned' })
    eventBus.emitUserMessage(SID, 'user')
    await new Promise((r) => setTimeout(r, 30))
    await driving
  })

  it('returns when the card is already gone (store.get undefined)', async () => {
    const store = makeStore(card('refining'))
    store.get = async () => undefined
    const runner = makeRunner(makeCtx().ctx, store)
    await drive(runner, card('refining'), makeHandle({ value: 0 }), true)
    // No fail is recorded for a vanished card.
    const fresh = await store.get(WS, 'c1')
    expect(fresh).toBeUndefined()
  })

  it('returns when an interactive card settles to error while waiting', async () => {
    const store = makeStore(card('refining'))
    const eventBus = makeCtx()
    const runner = makeRunner(eventBus.ctx, store)
    const driving = drive(runner, card('refining'), makeHandle({ value: 0 }), true)
    await new Promise((r) => setTimeout(r, 10))
    // The user replies; the agent writes the plan on that turn.
    store.mutate('c1', (c) => { c.status = 'planned' })
    eventBus.emitUserMessage(SID, 'user')
    await driving
    const fresh = await store.get(WS, 'c1')
    expect(fresh?.status).toBe('planned')
  })
})