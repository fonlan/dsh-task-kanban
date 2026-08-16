import { useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

let client: ClientContext | null = null
export function setClient(ctx: ClientContext | null): void {
  client = ctx
}
export function getClient(): ClientContext | null {
  return client
}

let boardRoot: ((props: Record<string, unknown>) => React.ReactNode) | null = null
export function setBoardRoot(component: (props: Record<string, unknown>) => React.ReactNode): void {
  boardRoot = component
}
export function getBoardRoot(): ((props: Record<string, unknown>) => React.ReactNode) | null {
  return boardRoot
}

let boardDisposer: (() => void) | null = null
let boardOpen = false
const listeners = new Set<() => void>()
function notify(): void {
  for (const l of listeners) l()
}
export function isBoardOpen(): boolean {
  return boardOpen
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
export function useBoardOpen(): boolean {
  return useSyncExternalStore(subscribe, isBoardOpen)
}

export function enterBoard(): void {
  const ctx = client
  const root = boardRoot
  if (ctx === null || root === null || boardDisposer !== null) return
  try {
    boardDisposer = ctx.slots.register({ name: 'conversation', priority: -1, locale: 'task-kanban' } as never, root as never)
    boardOpen = true
    notify()
  } catch (error) {
    console.error('[@fonlan/dsh-task-kanban] cannot open the board:', error)
  }
}

export function exitBoard(): void {
  if (boardDisposer !== null) {
    boardDisposer()
    boardDisposer = null
  }
  if (boardOpen) {
    boardOpen = false
    notify()
  }
}

export function toggleBoard(): void {
  if (boardOpen) exitBoard()
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
 * second bind (plugin re-apply / HMR) from stacking another layer.
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