import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KANBAN_PANEL_ID,
  bindSessionNavigation,
  leaveKanbanPanel,
  setClient,
  showKanbanPanel,
} from '../src/client/kanban-state'

interface FakeSessions {
  open: (id: string) => void
  openSubagent: (address: unknown) => void
  spyOpen: ReturnType<typeof vi.fn>
  spyOpenSubagent: ReturnType<typeof vi.fn>
}

/** Sessions double recording calls like the real ISessions service. */
function makeSessions(): FakeSessions {
  const spyOpen = vi.fn((_id: string) => undefined)
  const spyOpenSubagent = vi.fn((_address: unknown) => undefined)
  return {
    open: spyOpen,
    openSubagent: spyOpenSubagent,
    spyOpen,
    spyOpenSubagent,
  }
}

/**
 * Minimal ClientContext stand-in: the sessions service plus the shell's panel
 * face (`ctx.layout`), which records every selection.
 */
interface FakeCtx {
  sessions: FakeSessions
  layout: { selectPanel: ReturnType<typeof vi.fn> }
}

function makeCtx(sessions: FakeSessions = makeSessions()): FakeCtx {
  return { sessions, layout: { selectPanel: vi.fn() } }
}

afterEach(() => {
  setClient(null)
})

describe('panel selection', () => {
  it('selects the kanban panel by its shared id', () => {
    const ctx = makeCtx()
    setClient(ctx as never)

    showKanbanPanel()

    expect(ctx.layout.selectPanel).toHaveBeenCalledWith(KANBAN_PANEL_ID)
  })

  it('returns the center column to the Conversation with null', () => {
    const ctx = makeCtx()
    setClient(ctx as never)

    leaveKanbanPanel()

    expect(ctx.layout.selectPanel).toHaveBeenCalledWith(null)
  })

  it('tolerates a runtime without the layout service', () => {
    setClient({ sessions: makeSessions() } as never)

    expect(() => showKanbanPanel()).not.toThrow()
    expect(() => leaveKanbanPanel()).not.toThrow()
  })

  it('tolerates a layout service that throws on an unregistered panel', () => {
    const ctx = makeCtx()
    ctx.layout.selectPanel.mockImplementation(() => {
      throw new Error('main panel "task-kanban" is not registered')
    })
    setClient(ctx as never)

    expect(() => showKanbanPanel()).not.toThrow()
  })
})

describe('bindSessionNavigation', () => {
  it('returns to the Conversation before opening a session from the sidebar', () => {
    const sessions = makeSessions()
    const ctx = makeCtx(sessions)
    setClient(ctx as never)
    bindSessionNavigation(ctx as never)

    ctx.sessions.open('s1')

    expect(ctx.layout.selectPanel).toHaveBeenCalledWith(null)
    expect(sessions.spyOpen).toHaveBeenCalledTimes(1)
    expect(sessions.spyOpen).toHaveBeenCalledWith('s1')
  })

  it('returns to the Conversation when re-clicking the already-current session', () => {
    const sessions = makeSessions()
    const ctx = makeCtx(sessions)
    setClient(ctx as never)
    bindSessionNavigation(ctx as never)

    // The session stays current — the click still must leave the board.
    ctx.sessions.open('s1')

    expect(ctx.layout.selectPanel).toHaveBeenCalledWith(null)
    expect(sessions.spyOpen).toHaveBeenCalledTimes(1)
  })

  it('returns to the Conversation before opening a catalog child via openSubagent', () => {
    const sessions = makeSessions()
    const ctx = makeCtx(sessions)
    setClient(ctx as never)
    bindSessionNavigation(ctx as never)

    const address = { parentSessionId: 'p', childSessionId: 'c' }
    ctx.sessions.openSubagent(address)

    expect(ctx.layout.selectPanel).toHaveBeenCalledWith(null)
    expect(sessions.spyOpenSubagent).toHaveBeenCalledTimes(1)
    expect(sessions.spyOpenSubagent).toHaveBeenCalledWith(address)
  })

  it('leaves the panel selection alone when the runtime provides no layout face', () => {
    const sessions = makeSessions()
    const ctx = { sessions } as unknown as FakeCtx
    setClient(ctx as never)
    bindSessionNavigation(ctx as never)

    expect(() => ctx.sessions.open('s1')).not.toThrow()
    expect(sessions.spyOpen).toHaveBeenCalledWith('s1')
  })

  it('does not stack wrappers when bound twice', () => {
    const sessions = makeSessions()
    const ctx = makeCtx(sessions)
    setClient(ctx as never)

    bindSessionNavigation(ctx as never)
    bindSessionNavigation(ctx as never)
    ctx.sessions.open('s1')

    expect(sessions.spyOpen).toHaveBeenCalledTimes(1)
    expect(ctx.layout.selectPanel).toHaveBeenCalledTimes(1)
  })

  it('keeps the wrapped call through an HMR-style module re-evaluation', () => {
    // Regression: the client-hmr hot swap re-evaluates the plugin module. The
    // wrapper installed by the OLD module copy stays on `sessions.open`
    // (kbBound idempotency skips re-binding), and it must still hand the center
    // column back to the Conversation for a board opened by the NEW copy —
    // panel selection lives in the shell's store, so both copies agree.
    const sessions = makeSessions()
    const ctx = makeCtx(sessions)
    setClient(ctx as never)
    bindSessionNavigation(ctx as never) // "old module copy" binds first
    bindSessionNavigation(ctx as never) // "new copy" sees kbBound=true

    showKanbanPanel()
    ctx.sessions.open('s1')

    expect(ctx.layout.selectPanel).toHaveBeenNthCalledWith(1, KANBAN_PANEL_ID)
    expect(ctx.layout.selectPanel).toHaveBeenNthCalledWith(2, null)
    expect(sessions.spyOpen).toHaveBeenCalledWith('s1')
  })
})
