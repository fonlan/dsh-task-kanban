import type { Context } from '@deepseek-ai/cordis'
type ClientContext = Context
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BoardRoot } from './board'
import { KanbanFooterButton, KanbanSettingsSection } from './sections'
import { LOCALE_NS, zh, en } from './locales'
import { setClient, setBoardRoot, bindSessionNavigation } from './kanban-state'

/** The settings sidebar entry this plugin's page owns (must stay stable). */
const SETTINGS_SECTION_ID = 'task-kanban'

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

  // The plugin's own settings page (设置 -> 侧栏「任务看板」) rides the
  // task-kanban settings namespace and registers into the settings.section
  // list slot, which gives it one entry in the settings sidebar and renders
  // its content into the panel's content column.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: SETTINGS_SECTION_ID,
      order: 200,
      label: () => t('settingsTitle'),
      locale: LOCALE_NS,
    }, KanbanSettingsSection as never),
  )
}