import type { Context } from '@deepseek-ai/cordis'
type ClientContext = Context
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BoardRoot } from './board'
import { KanbanPanelIcon, KanbanSettingsSection } from './sections'
import { LOCALE_NS, zh, en } from './locales'
import { KANBAN_PANEL_ID, setClient, bindSessionNavigation } from './kanban-state'

/** The settings sidebar entry this plugin's page owns (must stay stable). */
const SETTINGS_SECTION_ID = 'task-kanban'

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'sessions', 'workspaces', 'locale']

/** Client plugin body. */
export function apply(ctx: ClientContext): void {
  setClient(ctx)
  // Selecting a session while the board is open must return to the Conversation.
  bindSessionNavigation(ctx)

  // Live translate bound to the active locale (labels re-read it per call).
  const t = ctx.locale.bind(LOCALE_NS)
  ctx.effect(() => {
    const off = ctx.locale.register(LOCALE_NS, { zh, en })
    return () => off()
  }, 'task-kanban: dictionaries')

  // The board is a GLOBAL MAIN PANEL: the shell renders one `main` entry per
  // selected panel id, so keying it (instead of replacing `main.conversation`)
  // keeps the Conversation mounted and selectable beside the board, and the
  // sidebar's own panel row owns the button that selects it (the
  // `sidebar.panellist` entry below). Nothing of this plugin sits in the
  // sidebar foot any more, so the Settings trigger can never be squeezed.
  ctx.slots.inject('main', () =>
    ctx.slots.register({
      name: 'main',
      key: KANBAN_PANEL_ID,
      locale: LOCALE_NS,
    } as never, BoardRoot as never),
  )

  // Sidebar panel row: the shell renders the row (label, tooltip, active state)
  // and calls `layout.selectPanel(id)` on click; the entry supplies the glyph.
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({
      name: 'sidebar.panellist',
      id: KANBAN_PANEL_ID,
      order: 20,
      label: () => t('kanban'),
      locale: LOCALE_NS,
    }, KanbanPanelIcon as never),
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
