import { useCallback, useEffect, useRef, useState } from 'react'
import { IconChecklistOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type PresetOption, type ReasoningOptions } from './api'
import { toggleBoard, useBoardOpen } from './kanban-state'
import type { KanbanSettingsShape, ModelOption } from '../shared/card'

interface FooterActionProps {
  wide?: boolean
  t?: (key: string) => string
}

/** Sidebar footer entry: toggles the kanban board main view.
 *  The shell renders footer actions on their own row ABOVE the settings row,
 *  so the button is reparented into the settings area to sit on the same
 *  line, right of the Settings trigger (see board.css .kb-settings-row). */
export function KanbanFooterButton({ wide, t }: FooterActionProps): JSX.Element {
  const open = useBoardOpen()
  const ref = useRef<HTMLButtonElement | null>(null)
  const label = t !== undefined ? t(open ? 'closeBoard' : 'openBoard') : 'Task Kanban'

  useEffect(() => {
    const btn = ref.current
    if (btn === null) return
    let foot: Element | null = null
    let disposed = false

    // Locate the sidebar foot area WITHOUT moving any DOM: it is the ancestor
    // of the button whose LAST child contains the settings trigger and which
    // is itself the last child of its parent (root > footArea > settingsArea).
    // The slot machinery wraps entries in an anonymous div, so the search
    // tolerates extra wrapper levels. Styling is pure CSS (see board.css
    // .kb-foot-row), so a failed lookup only leaves the button in its natural
    // slot row — it can never vanish.
    const findFoot = (): Element | null => {
      let el: Element | null = btn.parentElement
      while (el !== null && el !== document.body && el.parentElement !== null) {
        const last = el.lastElementChild
        const hasTrigger =
          last !== null &&
          (last.querySelector?.('button[aria-haspopup="dialog"]') !== null ||
            last.querySelector?.('button[aria-haspopup="menu"]') !== null)
        const isLastChild = el.parentElement.lastElementChild === el
        if (hasTrigger && isLastChild) return el
        el = el.parentElement
      }
      return null
    }

    const tryApply = (): boolean => {
      if (foot === null) {
        try {
          foot = findFoot()
        } catch {
          foot = null
        }
      }
      if (foot === null) return false
      try {
        foot.classList.add('kb-foot-row')
        foot.classList.toggle('kb-foot-rail', wide !== true)
      } catch {
        // element already gone; retry will re-locate
      }
      return true
    }

    let applied = false
    try {
      applied = tryApply()
    } catch (error) {
      console.error('[@fonlan/dsh-task-kanban] foot placement error:', error)
    }
    if (!applied) {
      // The settings entry may mount later than this entry (plugin load
      // order); retry on DOM mutations AND on a short interval until the
      // foot area is found (give up after 15s).
      const observer = new MutationObserver(() => {
        if (disposed) return
        if (tryApply()) observer.disconnect()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      const timer = window.setInterval(() => {
        if (disposed) {
          window.clearInterval(timer)
          return
        }
        if (tryApply()) {
          observer.disconnect()
          window.clearInterval(timer)
        }
      }, 1000)
      window.setTimeout(() => {
        observer.disconnect()
        window.clearInterval(timer)
        if (foot === null) {
          // report the DOM chain so the next report carries evidence
          const chain: string[] = []
          let el: Element | null = btn.parentElement
          while (el !== null && chain.length < 8) {
            chain.push(el.tagName + '.' + String(el.className).slice(0, 60))
            el = el.parentElement
          }
          console.warn('[@fonlan/dsh-task-kanban] could not locate the sidebar foot area:', chain)
        }
      }, 15000)
      return () => {
        disposed = true
        observer.disconnect()
        window.clearInterval(timer)
        try {
          foot?.classList.remove('kb-foot-row')
          foot?.classList.remove('kb-foot-rail')
        } catch {
          // already gone
        }
      }
    }
    return () => {
      try {
        foot?.classList.remove('kb-foot-row')
        foot?.classList.remove('kb-foot-rail')
      } catch {
        // already gone
      }
    }
  }, [wide])

  return (
    <button
      ref={ref}
      type="button"
      className={'kb-footer-action' + (wide === true ? ' kb-footer-action-wide' : '') + (open ? ' kb-footer-action-active' : '')}
      aria-label={label}
      title={label}
      onClick={() => toggleBoard()}
    >
      <IconChecklistOutline14 size={wide === true ? 16 : 18} />
      {wide === true && <span className="kb-footer-label">{t !== undefined ? t('kanban') : 'Kanban'}</span>}
    </button>
  )
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

/** Plugin settings section: workers + default model + per-session-type defaults. */
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
  )
}