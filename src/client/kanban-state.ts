import { useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

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
const STATE_KEY = Symbol.for('@fonlan/dsh-task-kanban/state')

interface KanbanState {
  client: ClientContext | null
  boardRoot: ((props: Record<string, unknown>) => React.ReactNode) | null
  boardDisposer: (() => void) | null
  boardOpen: boolean
  listeners: Set<() => void>
}

function getState(): KanbanState {
  const g = globalThis as unknown as Record<symbol, KanbanState | undefined>
  let state = g[STATE_KEY]
  if (state === undefined) {
    state = {
      client: null,
      boardRoot: null,
      boardDisposer: null,
      boardOpen: false,
      listeners: new Set(),
    }
    g[STATE_KEY] = state
  }
  return state
}

export function setClient(ctx: ClientContext | null): void {
  getState().client = ctx
}
export function getClient(): ClientContext | null {
  return getState().client
}

export function setBoardRoot(component: (props: Record<string, unknown>) => React.ReactNode): void {
  getState().boardRoot = component
}
export function getBoardRoot(): ((props: Record<string, unknown>) => React.ReactNode) | null {
  return getState().boardRoot
}

function notify(): void {
  for (const listener of getState().listeners) listener()
}
export function isBoardOpen(): boolean {
  return getState().boardOpen
}
function subscribe(cb: () => void): () => void {
  const listeners = getState().listeners
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
export function useBoardOpen(): boolean {
  return useSyncExternalStore(subscribe, isBoardOpen)
}

export function enterBoard(): void {
  const state = getState()
  const ctx = state.client
  const root = state.boardRoot
  if (ctx === null || root === null || state.boardDisposer !== null) return
  try {
    state.boardDisposer = ctx.slots.register({ name: 'conversation', priority: -1, locale: 'task-kanban' } as never, root as never)
    state.boardOpen = true
    notify()
  } catch (error) {
    console.error('[@fonlan/dsh-task-kanban] cannot open the board:', error)
  }
}

export function exitBoard(): void {
  const state = getState()
  if (state.boardDisposer !== null) {
    state.boardDisposer()
    state.boardDisposer = null
  }
  if (state.boardOpen) {
    state.boardOpen = false
    notify()
  }
}

export function toggleBoard(): void {
  if (isBoardOpen()) exitBoard()
  else enterBoard()
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
export function bindSessionNavigation(ctx: ClientContext): void {
  const sessions = ctx.sessions
  if (sessions === undefined) return

  const open = sessions.open
  if (typeof open === 'function' && (open as unknown as { kbBound?: boolean }).kbBound !== true) {
    const bound = ((id: Parameters<typeof open>[0]) => {
      exitBoard()
      return open.call(sessions, id)
    }) as typeof open
    ;(bound as unknown as { kbBound?: boolean }).kbBound = true
    sessions.open = bound
  }

  const openSubagent = sessions.openSubagent
  if (typeof openSubagent === 'function' && (openSubagent as unknown as { kbBound?: boolean }).kbBound !== true) {
    const bound = ((address: Parameters<typeof openSubagent>[0]) => {
      exitBoard()
      return openSubagent.call(sessions, address)
    }) as typeof openSubagent
    ;(bound as unknown as { kbBound?: boolean }).kbBound = true
    sessions.openSubagent = bound
  }
}