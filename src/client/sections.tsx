import { useCallback, useEffect, useRef, useState } from 'react'
import { ChecklistIcon } from './icons'
import { api, type PresetOption, type ReasoningOptions } from './api'
import type { KanbanSettingsShape, ModelOption } from '../shared/card'

/**
 * Sidebar panel-row glyph for the board (`sidebar.panellist`).
 *
 * The shell owns the row: it renders the button, its label, tooltip and active
 * state, and calls `layout.selectPanel(id)` on click. The entry contributes
 * only the glyph, so this component must stay purely presentational.
 */
export function KanbanPanelIcon({ size }: { size: number }): JSX.Element {
  return <ChecklistIcon size={size} />
}

interface SettingsSectionProps {
  t?: (key: string) => string
}

/** Fallback shape while settings load (server always resolves the full set). */
const EMPTY_SETTINGS: KanbanSettingsShape = {
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

/** The setting field names of one session-type group. */
const GROUP_FIELDS = {
  refinement: {
    model: 'refinementModel',
    provider: 'refinementProvider',
    effort: 'refinementReasoningEffort',
    preset: 'refinementPreset',
  },
  phase: {
    model: 'phaseModel',
    provider: 'phaseProvider',
    effort: 'phaseReasoningEffort',
    preset: 'phasePreset',
  },
} as const

type SessionGroupKey = keyof typeof GROUP_FIELDS

interface SessionDefaultsGroupProps {
  kind: SessionGroupKey
  settings: KanbanSettingsShape
  models: ModelOption[]
  presets: PresetOption[]
  /** Reasoning efforts already fetched, keyed `provider/model`. */
  efforts: Record<string, ReasoningOptions>
  tr: (key: string) => string
  onCommit: (patch: Partial<KanbanSettingsShape>) => Promise<void>
  loadEfforts: (provider: string, model: string) => void
}

/** Model / reasoning effort / agent preset defaults for one session type. */
function SessionDefaultsGroup({ kind, settings, models, presets, efforts, tr, onCommit, loadEfforts }: SessionDefaultsGroupProps): JSX.Element {
  const fields = GROUP_FIELDS[kind]
  const model = settings[fields.model]
  const provider = settings[fields.provider]
  const effort = settings[fields.effort]
  const preset = settings[fields.preset]
  const effortKey = model !== '' && provider !== '' ? `${provider}/${model}` : ''
  const effortOptions = effortKey !== '' ? (efforts[effortKey]?.efforts ?? []) : []

  const handleModel = (id: string): void => {
    const found = models.find((m) => m.id === id)
    const nextProvider = found?.provider ?? ''
    void onCommit({ [fields.model]: id, [fields.provider]: nextProvider } as Partial<KanbanSettingsShape>)
    if (id !== '' && nextProvider !== '') loadEfforts(nextProvider, id)
  }

  return (
    <div className="kb-settings-group">
      <div className="kb-settings-group-title">{tr(kind === 'refinement' ? 'settingsRefineGroup' : 'settingsPhaseGroup')}</div>
      <label className="kb-field kb-field-row">
        <span>{tr('model')}</span>
        <select className="kb-input" value={model} onChange={(e) => handleModel(e.target.value)}>
          <option value="">{tr('defaultOption')}</option>
          {models.map((m) => (
            <option key={m.provider + '/' + m.id} value={m.id}>{m.name ?? m.id}</option>
          ))}
        </select>
      </label>
      <label className="kb-field kb-field-row">
        <span>{tr('reasoningEffort')}</span>
        <select
          className="kb-input"
          value={effort}
          disabled={model === ''}
          onChange={(e) => void onCommit({ [fields.effort]: e.target.value } as Partial<KanbanSettingsShape>)}
        >
          <option value="">{tr('defaultOption')}</option>
          {effortOptions.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      </label>
      <label className="kb-field kb-field-row">
        <span>{tr('agentPreset')}</span>
        <select
          className="kb-input"
          value={preset}
          onChange={(e) => void onCommit({ [fields.preset]: e.target.value } as Partial<KanbanSettingsShape>)}
        >
          <option value="">{tr('defaultOption')}</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{p.name ?? p.id}</option>
          ))}
        </select>
      </label>
    </div>
  )
}

/** Plugin settings page (设置 -> 侧栏「任务看板」): workers + default model + per-session-type defaults. */
export function KanbanSettingsSection({ t }: SettingsSectionProps): JSX.Element {
  const tr = t ?? ((key: string) => key)
  const [settings, setSettings] = useState<KanbanSettingsShape>(EMPTY_SETTINGS)
  const [models, setModels] = useState<ModelOption[]>([])
  const [presets, setPresets] = useState<PresetOption[]>([])
  const [efforts, setEfforts] = useState<Record<string, ReasoningOptions>>({})
  const [saved, setSaved] = useState(false)

  const commit = useCallback(async (patch: Partial<KanbanSettingsShape>): Promise<void> => {
    try {
      const next = await api.settingsSet(patch)
      setSettings(next)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1500)
    } catch {
      // keep the previous value
    }
  }, [])

  // Refs so async callbacks (effort fetch) read the freshest settings/commit.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const commitRef = useRef(commit)
  commitRef.current = commit

  useEffect(() => {
    let alive = true
    api.settingsGet()
      .then((s) => { if (alive) setSettings(s) })
      .catch(() => undefined)
    api.models()
      .then((list) => { if (alive) setModels(list) })
      .catch(() => undefined)
    api.presets()
      .then((list) => { if (alive) setPresets(list) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])

  /** Reasoning routes already requested (dedupe across mount + model changes). */
  const effortFetched = useRef<Set<string>>(new Set())

  /**
   * Fetch the reasoning efforts of one model route (once per route). A failed
   * fetch is marked `failed` so the stored effort is preserved (see the reset
   * effect below) instead of being wiped by a transient error.
   */
  const loadEfforts = useCallback((provider: string, model: string): void => {
    const key = `${provider}/${model}`
    if (effortFetched.current.has(key)) return
    effortFetched.current.add(key)
    api.reasoningOptions(provider, model)
      .then((opts) => setEfforts((prev) => ({ ...prev, [key]: opts })))
      .catch(() => setEfforts((prev) => ({ ...prev, [key]: { efforts: [], failed: true } })))
  }, [])

  // Fetch efforts for the models already configured in settings, so the
  // effort selects show their levels (and validate the stored effort) as soon
  // as settings load — the fetch previously ran only on model change.
  useEffect(() => {
    for (const kind of ['refinement', 'phase'] as const) {
      const fields = GROUP_FIELDS[kind]
      const model = settings[fields.model]
      const provider = settings[fields.provider]
      if (model !== '' && provider !== '') loadEfforts(provider, model)
    }
  }, [settings.refinementModel, settings.refinementProvider, settings.phaseModel, settings.phaseProvider, loadEfforts])

  // When the efforts of the selected model arrive, drop a stored effort the
  // model no longer offers (e.g. the user switched the model). A failed fetch
  // (`failed: true`) keeps the stored effort: the model may just be
  // temporarily unresolvable, and wiping the user's choice would be worse.
  useEffect(() => {
    const s = settingsRef.current
    for (const kind of ['refinement', 'phase'] as const) {
      const fields = GROUP_FIELDS[kind]
      const model = s[fields.model]
      const provider = s[fields.provider]
      const effort = s[fields.effort]
      if (effort === '' || model === '' || provider === '') continue
      const opts = efforts[`${provider}/${model}`]
      if (opts === undefined || opts.failed === true) continue
      if (!opts.efforts.some((o) => o.id === effort)) {
        void commitRef.current({ [fields.effort]: '' } as Partial<KanbanSettingsShape>)
      }
    }
  }, [efforts])

  return (
    <div className="kb-page">
      <header className="kb-page-head">
        <h3 className="kb-page-title">{tr('settingsTitle')}</h3>
        <p className="kb-page-sub">{tr('sectionSub')}</p>
      </header>
      <div className="kb-settings">
        <label className="kb-field kb-field-row">
          <span>{tr('maxParallelWorkers')}</span>
          <input
            className="kb-input kb-input-number"
            type="number"
            min={1}
            step={1}
            value={settings.maxParallelWorkers}
            onChange={(e) => {
              const value = Math.max(1, Math.floor(Number(e.target.value) || 1))
              setSettings((s) => ({ ...s, maxParallelWorkers: value }))
              void commit({ maxParallelWorkers: value })
            }}
          />
        </label>
        <SessionDefaultsGroup
          kind="refinement"
          settings={settings}
          models={models}
          presets={presets}
          efforts={efforts}
          tr={tr}
          onCommit={commit}
          loadEfforts={loadEfforts}
        />
        <SessionDefaultsGroup
          kind="phase"
          settings={settings}
          models={models}
          presets={presets}
          efforts={efforts}
          tr={tr}
          onCommit={commit}
          loadEfforts={loadEfforts}
        />
        {saved && <div className="kb-settings-saved">{tr('saved')}</div>}
      </div>
    </div>
  )
}