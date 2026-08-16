/**
 * Declare this plugin's locale namespace so slot registrations can type-check
 * the `locale` seat and receive the typed `t` prop. zh is the key source
 * of truth; en must carry the exact same key set (checked at runtime by the
 * locale registry).
 */
import type { zh } from './locales'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'task-kanban': keyof typeof zh
  }
}

export {}
