import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindSessionNavigation,
  enterBoard,
  exitBoard,
  isBoardOpen,
  setBoardRoot,
  setClient,
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

/** Minimal ClientContext stand-in: sessions service + slot registry. */
function makeCtx(sessions: FakeSessions): { sessions: FakeSessions; slots: { register: () => () => void } } {
  return {
    sessions,
    slots: {
      register: () => () => undefined,
    },
  }
}

function openBoard(ctx: { sessions: FakeSessions; slots: { register: () => () => void } }): void {
  setClient(ctx as never)
  setBoardRoot((() => null) as never)
  enterBoard()
  expect(isBoardOpen()).toBe(true)
}

afterEach(() => {
  exitBoard()
  setClient(null)
  setBoardRoot(null)
})

describe('bindSessionNavigation', () => {
  it('exits the board before opening a session from the sidebar', () => {
    const sessions = makeSessions()
    const ctx = makeCtx(sessions)
    openBoard(ctx)
    bindSessionNavigation(ctx as never)

    ctx.sessions.open('s1')

    expect(isBoardOpen()).toBe(false)
    expect(sessions.spyOpen).toHaveBeenCalledTimes(1)
    expect(sessions.spyOpen).toHaveBeenCalledWith('s1')
  })

  it('exits the board when re-clicking the already-current session', () => {
    const sessions = makeSessions()
    const ctx = makeCtx(sessions)
    openBoard(ctx)
    bindSessionNavigation(ctx as never)

    // The session stays current — the click still must leave the board.
    ctx.sessions.open('s1')

    expect(isBoardOpen()).toBe(false)
    expect(sessions.spyOpen).toHaveBeenCalledTimes(1)
  })

  it('exits the board before opening a catalog child via openSubagent', () => {
    const sessions = makeSessions()
    const ctx = makeCtx(sessions)
    openBoard(ctx)
    bindSessionNavigation(ctx as never)

    const address = { parentSessionId: 'p', childSessionId: 'c' }
    ctx.sessions.openSubagent(address)

    expect(isBoardOpen()).toBe(false)
    expect(sessions.spyOpenSubagent).toHaveBeenCalledTimes(1)
    expect(sessions.spyOpenSubagent).toHaveBeenCalledWith(address)
  })

  it('passes opens through untouched while the board is closed', () => {
    const sessions = makeSessions()
    const ctx = makeCtx(sessions)
    bindSessionNavigation(ctx as never)

    ctx.sessions.open('s1')
    ctx.sessions.openSubagent({ parentSessionId: 'p', childSessionId: 'c' })

    expect(isBoardOpen()).toBe(false)
    expect(sessions.spyOpen).toHaveBeenCalledTimes(1)
    expect(sessions.spyOpenSubagent).toHaveBeenCalledTimes(1)
  })

  it('keeps the wrapped call through a board re-enter after the exit', () => {
    const sessions = makeSessions()
    const ctx = makeCtx(sessions)
    openBoard(ctx)
    bindSessionNavigation(ctx as never)

    ctx.sessions.open('s1') // exits the board
    openBoard(ctx) // user opens the board again
    ctx.sessions.open('s2') // exits it again

    expect(isBoardOpen()).toBe(false)
    expect(sessions.spyOpen).toHaveBeenNthCalledWith(1, 's1')
    expect(sessions.spyOpen).toHaveBeenNthCalledWith(2, 's2')
  })

  it('does not stack wrappers when bound twice', () => {
    const sessions = makeSessions()
    const ctx = makeCtx(sessions)
    openBoard(ctx)

    bindSessionNavigation(ctx as never)
    bindSessionNavigation(ctx as never)
    ctx.sessions.open('s1')

    expect(isBoardOpen()).toBe(false)
    expect(sessions.spyOpen).toHaveBeenCalledTimes(1)
  })

  it('exits a board opened after an HMR-style module re-evaluation', () => {
    // Regression: the client-hmr hot swap re-evaluates the plugin module. The
    // wrapper installed by the OLD module copy stays on `sessions.open`
    // (kbBound idempotency skips re-binding), so its `exitBoard` must close
    // the SAME shared board state that the NEW module copy's `enterBoard`
    // opens. Module-level singletons would break this (old exit vs new enter).
    const sessions = makeSessions()
    const ctx = makeCtx(sessions)
    bindSessionNavigation(ctx as never) // "old module copy" binds first

    // Simulate the swap: the "new copy" re-applies and sees kbBound=true
    // (skips re-wrapping) — then the user opens the board through the new
    // copy's enterBoard, and clicks a session through the old copy's wrapper.
    bindSessionNavigation(ctx as never)
    openBoard(ctx)

    ctx.sessions.open('s1')

    expect(isBoardOpen()).toBe(false)
    expect(sessions.spyOpen).toHaveBeenCalledTimes(1)
    expect(sessions.spyOpen).toHaveBeenCalledWith('s1')
  })
})
