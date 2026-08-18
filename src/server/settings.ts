/**
 * User-facing plugin settings (global parallel worker count, per-session-type
 * model/effort/preset defaults), persisted through the settings service
 * namespace `task-kanban`. The DSH settings service requires a lowercase
 * kebab-case namespace (/^[a-z][a-z0-9-]*$/), so the scoped package name
 * cannot be used here.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { KanbanSessionKind, KanbanSettingsShape } from '../shared/card.js'

export const KANBAN_SETTINGS_NS = settingsNamespace('task-kanban')

export const KanbanSettingsSchema = z.object({
  maxParallelWorkers: z.natural().min(1).default(1),
  refinementModel: z.string().default(''),
  refinementProvider: z.string().default(''),
  refinementReasoningEffort: z.string().default(''),
  refinementPreset: z.string().default(''),
  phaseModel: z.string().default(''),
  phaseProvider: z.string().default(''),
  phaseReasoningEffort: z.string().default(''),
  phasePreset: z.string().default(''),
})

/** The per-session-type default slice a session kind resolves. */
export interface KanbanSessionDefaults {
  model: string
  provider: string
  reasoningEffort: string
  preset: string
}

export interface KanbanSettingsFace {
  get(): KanbanSettingsShape
  update(patch: Partial<KanbanSettingsShape>): Promise<void>
  /** Default provider/model route from the agent-default-model settings namespace. */
  defaultModelRoute(): { provider?: string; model?: string }
  /**
   * The configured model/effort/preset defaults for one session kind.
   * `merge` sessions deliberately carry no per-type defaults: they keep the
   * legacy resolution chain (card model → host default).
   */
  sessionDefaults(kind: KanbanSessionKind): KanbanSessionDefaults
}

/** Structural settings-service subset; the real service resolves the schema. */
interface SettingsServiceLike {
  register(ns: unknown, schema: unknown): unknown
  update(ns: unknown, patch: Record<string, unknown>, expectedRevision?: number): Promise<unknown>
}

const EMPTY_DEFAULTS: KanbanSessionDefaults = { model: '', provider: '', reasoningEffort: '', preset: '' }

export function registerSettings(ctx: Context): KanbanSettingsFace {
  let current: KanbanSettingsShape = {
    maxParallelWorkers: 1,
    refinementModel: '',
    refinementProvider: '',
    refinementReasoningEffort: '',
    refinementPreset: '',
    phaseModel: '',
    phaseProvider: '',
    phaseReasoningEffort: '',
    phasePreset: '',
  }
  let service: SettingsServiceLike | undefined
  ctx.inject(['settings'], (sctx) => {
    service = sctx.settings as unknown as SettingsServiceLike
    const scope = service.register(KANBAN_SETTINGS_NS, KanbanSettingsSchema) as {
      get(): KanbanSettingsShape
      watch(callback: (next: KanbanSettingsShape) => void): () => void
    }
    current = scope.get()
    scope.watch((next) => { current = next })
  })
  return {
    get: () => current,
    sessionDefaults: (kind) => {
      const s = current
      switch (kind) {
        case 'refine':
          return { model: s.refinementModel, provider: s.refinementProvider, reasoningEffort: s.refinementReasoningEffort, preset: s.refinementPreset }
        case 'phase':
          return { model: s.phaseModel, provider: s.phaseProvider, reasoningEffort: s.phaseReasoningEffort, preset: s.phasePreset }
        case 'merge':
          return EMPTY_DEFAULTS
      }
    },
    defaultModelRoute: () => {
      if (service === undefined) return {}
      try {
        const descriptors = (service as unknown as { describe(opts: { redactSecrets: boolean }): Array<{ ns: unknown; value: unknown }> })
          .describe({ redactSecrets: true })
        for (const d of descriptors) {
          if (String(d.ns) === 'agent-default-model') {
            const v = (d.value ?? {}) as { provider?: string; model?: string }
            return { provider: v.provider, model: v.model }
          }
        }
      } catch {
        // fall through
      }
      return {}
    },
    update: async (patch) => {
      if (service === undefined) {
        throw new Error('@fonlan/dsh-task-kanban: settings service is not available in this profile')
      }
      await service.update(KANBAN_SETTINGS_NS, patch as Record<string, unknown>)
    },
  }
}
