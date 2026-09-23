import type { Context } from '@deepseek-ai/cordis'
type ClientContext = Context

/**
 * Panel id shared by this plugin's main-panel key (`main`) and its sidebar
 * entry (`sidebar.panellist`): the shell selects the panel by this id, so the
 * two registrations must agree.
 */
export const KANBAN_PANEL_ID = 'task-kanban'

/**
 * Structural view of the client shell's panel-navigation face (`ctx.layout`).
 * Declared locally (no value import) so the plugin keeps working on a runtime
 * whose layout types differ.
 */
interface LayoutLike {
  selectPanel(panelId: string | null): void
}

/**
 * HMR-safe owner context, keyed on the global symbol registry.
 *
 * The client-hmr hot swap re-evaluates this module (a fresh `lib/client.js`
 * bundle) WITHOUT reloading the page; a module-level cell would then be
 * duplicated per evaluation and an old copy's helper would read a stale owner.
 * `Symbol.for` makes every bundle copy share one cell.
 */
const STATE_KEY = Symbol.for('@fonlan/dsh-task-kanban/state')

interface KanbanState {
  client: ClientContext | null
}

function getState(): KanbanState {
  const g = globalThis as unknown as Record<symbol, KanbanState | undefined>
  let state = g[STATE_KEY]
  if (state === undefined) {
    state = { client: null }
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

/** The shell's panel face, when this runtime provides it. */
function layoutOf(ctx: ClientContext | null): LayoutLike | null {
  if (ctx === null) return null
  try {
    const layout = (ctx as unknown as { layout?: LayoutLike }).layout
    return typeof layout?.selectPanel === 'function' ? layout : null
  } catch {
    return null
  }
}

/** Select the kanban panel. The sidebar's own entry does this; kept for in-app callers. */
export function showKanbanPanel(ctx: ClientContext | null = getClient()): void {
  try {
    layoutOf(ctx)?.selectPanel(KANBAN_PANEL_ID)
  } catch (error) {
    console.error('[@fonlan/dsh-task-kanban] cannot select the kanban panel:', error)
  }
}

/** Hand the center column back to the Conversation. */
export function leaveKanbanPanel(ctx: ClientContext | null = getClient()): void {
  try {
    layoutOf(ctx)?.selectPanel(null)
  } catch (error) {
    console.error('[@fonlan/dsh-task-kanban] cannot leave the kanban panel:', error)
  }
}

/**
 * Route session navigation through the panel selection: opening any session
 * while the board is the active panel first returns the center column to the
 * Conversation, so the session view renders.
 *
 * Every sidebar path that selects a session funnels through `sessions.open`
 * (session rows, search results, fork results, New Session) or
 * `sessions.openSubagent` (catalog children) — including re-clicking the
 * already-current session, which never changes `list.current` and therefore
 * cannot be caught by a list-store subscription. Wrapping the two entry points
 * covers all of them in one place.
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
      leaveKanbanPanel(ctx)
      return open.call(sessions, id)
    }) as typeof open
    ;(bound as unknown as { kbBound?: boolean }).kbBound = true
    sessions.open = bound
  }

  const openSubagent = sessions.openSubagent
  if (typeof openSubagent === 'function' && (openSubagent as unknown as { kbBound?: boolean }).kbBound !== true) {
    const bound = ((address: Parameters<typeof openSubagent>[0]) => {
      leaveKanbanPanel(ctx)
      return openSubagent.call(sessions, address)
    }) as typeof openSubagent
    ;(bound as unknown as { kbBound?: boolean }).kbBound = true
    sessions.openSubagent = bound
  }
}
