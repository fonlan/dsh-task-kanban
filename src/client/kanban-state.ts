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
 * Structural view of the client shell's workspace-navigation face
 * (`ctx.uiWorkspace`, dsh-client-ui-workspace). Declared locally (no value
 * import) so the plugin keeps working on a runtime whose workspace types differ.
 */
interface UiWorkspaceLike {
  /** Select a Session (id, or a direct-parent subagent address) and show it. */
  openSession(target: string): void
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
 * Open one session — or a durable direct-parent subagent address — in the
 * center column, leaving the kanban panel.
 *
 * Navigation is a view-owner concern, not a session-controller one: `ctx.sessions`
 * (`ISessions`) exposes retention (`retain`/`using`/`retainInfo`), creation,
 * fork, search and catalog reads, and has no `open`/`openSubagent` at all
 * ("navigation belongs to view owners"). The view owner the shell itself uses is
 * `ctx.uiWorkspace.openSession(target)` (dsh-client-ui-workspace): it retains the
 * session AND reveals the Conversation panel as ONE navigation action. Routing
 * every open through it therefore replaces the old wrapper around
 * `sessions.open`/`openSubagent`, which existed only to hand the center column
 * back when a sidebar click selected a session while the board was showing.
 *
 * @param target - session id (or subagent address) to show.
 * @returns whether the runtime provided the navigation face; `false` means the
 *   session could not be shown (a client without ui-workspace).
 */
export function openSessionView(target: string, ctx: ClientContext | null = getClient()): boolean {
  if (ctx === null) return false
  let uiWorkspace: UiWorkspaceLike | undefined
  try {
    uiWorkspace = (ctx as unknown as { uiWorkspace?: UiWorkspaceLike }).uiWorkspace
  } catch {
    return false
  }
  if (typeof uiWorkspace?.openSession !== 'function') return false
  try {
    uiWorkspace.openSession(target)
    return true
  } catch (error) {
    console.error('[@fonlan/dsh-task-kanban] cannot open the session view:', error)
    return false
  }
}
