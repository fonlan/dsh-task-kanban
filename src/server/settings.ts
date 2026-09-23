/**
 * User-facing plugin settings (global parallel worker count, per-session-type
 * model/effort/preset defaults), carried by this bundle's entry config: dsh
 * >= 0.1.7 owns plugin settings as entry config (the plugin's `Config`
 * schema), so the face reads the config it was applied with and persists
 * updates through `settings.update`.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KanbanSessionKind, KanbanSettingsShape } from '../shared/card.js'

export const KANBAN_SETTINGS_NS = 'task-kanban'

export const KanbanSettingsSchema: z<KanbanSettingsShape> = z.object({
  // Volatile: the settings plane (settings page / settings.update) only
  // writes volatile-marked fields on dsh >= 0.1.7.
  maxParallelWorkers: z.natural().min(1).default(1).volatile(),
  refinementModel: z.string().default('').volatile(),
  refinementProvider: z.string().default('').volatile(),
  refinementReasoningEffort: z.string().default('').volatile(),
  refinementPreset: z.string().default('').volatile(),
  phaseModel: z.string().default('').volatile(),
  phaseProvider: z.string().default('').volatile(),
  phaseReasoningEffort: z.string().default('').volatile(),
  phasePreset: z.string().default('').volatile(),
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
  update(ns: unknown, patch: Record<string, unknown>, expectedRevision?: number): Promise<unknown>
}

/** One config field as the loader hands it over: a stable volatile reference. */
interface VolatileField<T> {
  get(): T | undefined
}

/**
 * Dereference one config field. `Config` fields marked `.volatile()` are handed
 * to the plugin as references (`{ get() }`) instead of plain values, so reading
 * them raw yields the reference object — which serializes to `{}` and makes
 * every setting look empty. Non-volatile (plain) configs keep working as-is.
 */
function fieldValue<T>(value: unknown, fallback: T): T {
  if (value !== null && typeof value === 'object' && typeof (value as VolatileField<T>).get === 'function') {
    return (value as VolatileField<T>).get() ?? fallback
  }
  return (value as T | undefined) ?? fallback
}

const EMPTY_DEFAULTS: KanbanSessionDefaults = { model: '', provider: '', reasoningEffort: '', preset: '' }

export function registerSettings(ctx: Context, config: KanbanSettingsShape): KanbanSettingsFace {
  const fields = (config ?? {}) as unknown as Record<string, unknown>
  // Read the references on EVERY access: the settings plane updates them in
  // place (a volatile-only config change does not restart this entry).
  const snapshot = (): KanbanSettingsShape => ({
    maxParallelWorkers: fieldValue(fields.maxParallelWorkers, 1),
    refinementModel: fieldValue(fields.refinementModel, ''),
    refinementProvider: fieldValue(fields.refinementProvider, ''),
    refinementReasoningEffort: fieldValue(fields.refinementReasoningEffort, ''),
    refinementPreset: fieldValue(fields.refinementPreset, ''),
    phaseModel: fieldValue(fields.phaseModel, ''),
    phaseProvider: fieldValue(fields.phaseProvider, ''),
    phaseReasoningEffort: fieldValue(fields.phaseReasoningEffort, ''),
    phasePreset: fieldValue(fields.phasePreset, ''),
  })
  // Optimistic overlay: `settings.update` persists through the profile document
  // and refreshes the references asynchronously, so the write's own caller must
  // still observe the patch it just sent.
  let pending: Partial<KanbanSettingsShape> = {}
  const current = (): KanbanSettingsShape => ({ ...snapshot(), ...pending })
  let service: SettingsServiceLike | undefined
  // Optional settings service: without one the settings still resolve from
  // the entry config; edits just cannot persist.
  ctx.inject(['settings'], (sctx) => {
    service = (sctx as unknown as { settings?: SettingsServiceLike }).settings
  })
  return {
    get: () => current(),
    sessionDefaults: (kind) => {
      const s = current()
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
      // The settings plane keys plugin settings by PROFILE ENTRY id (the id in
      // cordis.patch.yml), which is what this plugin ships.
      await service.update(KANBAN_SETTINGS_NS, patch as Record<string, unknown>)
      pending = { ...pending, ...patch }
    },
  }
}
