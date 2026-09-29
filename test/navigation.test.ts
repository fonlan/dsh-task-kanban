import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KANBAN_PANEL_ID,
  leaveKanbanPanel,
  openSessionView,
  setClient,
  showKanbanPanel,
} from '../src/client/kanban-state'

/**
 * Minimal ClientContext stand-in: the shell's panel face (`ctx.layout`, which
 * records every selection) plus the workspace navigation face
 * (`ctx.uiWorkspace.openSession`), the real owner of session selection.
 */
interface FakeCtx {
  layout: { selectPanel: ReturnType<typeof vi.fn> }
  uiWorkspace: { openSession: ReturnType<typeof vi.fn> }
}

function makeCtx(): FakeCtx {
  return { layout: { selectPanel: vi.fn() }, uiWorkspace: { openSession: vi.fn() } }
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
    setClient({} as never)

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

describe('openSessionView', () => {
  it('opens the session through the workspace navigation face', () => {
    const ctx = makeCtx()
    setClient(ctx as never)

    expect(openSessionView('s1')).toBe(true)
    expect(ctx.uiWorkspace.openSession).toHaveBeenCalledTimes(1)
    expect(ctx.uiWorkspace.openSession).toHaveBeenCalledWith('s1')
  })

  it('reports failure when the runtime has no navigation face', () => {
    setClient({ layout: { selectPanel: vi.fn() } } as never)

    expect(openSessionView('s1')).toBe(false)
  })

  it('reports failure without a client owner', () => {
    expect(openSessionView('s1')).toBe(false)
  })

  it('contains a throwing navigation face', () => {
    const ctx = makeCtx()
    ctx.uiWorkspace.openSession.mockImplementation(() => {
      throw new Error('session "s1" is not listed')
    })
    setClient(ctx as never)

    expect(openSessionView('s1')).toBe(false)
  })
})
