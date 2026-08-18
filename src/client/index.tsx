import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { BoardRoot } from './board'
import { KanbanFooterButton, KanbanSettingsCard } from './sections'
import { LOCALE_NS, zh, en } from './locales'
import { setClient, setBoardRoot, bindSessionNavigation } from './kanban-state'

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'sessions', 'workspaces', 'locale']

/** Client plugin body. */
export function apply(ctx: ClientContext): void {
  setClient(ctx)
  setBoardRoot(BoardRoot as unknown as (props: Record<string, unknown>) => React.ReactNode)
  // Selecting a session while the board is open must leave the board first.
  bindSessionNavigation(ctx)

  // Live translate bound to the active locale (labels re-read it per call).
  const t = ctx.locale.bind(LOCALE_NS)
  ctx.effect(() => {
    const off = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => off()
  }, 'task-kanban: dictionaries')

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'task-kanban',
      order: 60,
      label: () => t('kanban'),
      locale: LOCALE_NS,
    }, KanbanFooterButton as never),
  )

  // The plugin's own Settings Card (设置 → 插件配置) rides the `task-kanban`
  // settings namespace: registering into the keyed `settings.plugin.item` slot
  // with the namespace string makes the configurable-plugins tab dispatch the
  // card next to the built-in ones (bash / agent loop / web search).
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'task-kanban',
      locale: LOCALE_NS,
    }, KanbanSettingsCard as never),
  )
}
