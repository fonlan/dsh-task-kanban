/**
 * @fonlan/dsh-task-kanban host half: the task kanban engine.
 *
 * Mounts a file-backed task store under each workspace's
 * `.dsh/task-kanban/`, runs refinement/phase/merge sessions through
 * `ctx.agents` (standard coding-agent preset + kanban-scoped tools), and
 * serves the fenced JSON API the board UI calls.
 */
import type { Context } from '@deepseek-ai/cordis'
import { KanbanSettingsSchema, registerSettings } from './server/settings.js'
import { TaskStore } from './server/task-store.js'
import { KanbanRunner } from './server/runner.js'
import { registerApiRoutes } from './server/rpc.js'
import type { KanbanSettingsShape } from './shared/card.js'

export const name = '@fonlan/dsh-task-kanban'

export const inject = ['webServer', 'agents', 'skills']

// The entry config is the settings document (worker count + per-session-type
// defaults); a changed config restarts this entry.
export const Config = KanbanSettingsSchema

export function apply(ctx: Context, config: KanbanSettingsShape): void {
  const settings = registerSettings(ctx, config)
  const store = new TaskStore()
  const runner = new KanbanRunner(ctx, store, settings)

  ctx.effect(() => {
    void runner.recoverInterrupted()
    runner.start()
    return () => runner.stop()
  }, 'task-kanban: runner lifecycle')

  ctx.effect(() => registerApiRoutes(ctx, runner, settings), 'task-kanban: api routes')
}
