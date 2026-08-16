import { useEffect, useRef, useState } from 'react'
import { IconChecklistOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api'
import { toggleBoard, useBoardOpen } from './kanban-state'
import type { KanbanSettingsShape } from '../shared/card'

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

/** Plugin settings section: global parallel workers + default model. */
export function KanbanSettingsSection({ t }: SettingsSectionProps): JSX.Element {
  const tr = t ?? ((key: string) => key)
  const [settings, setSettings] = useState<KanbanSettingsShape>({ maxParallelWorkers: 1, defaultModel: '' })
  const [models, setModels] = useState<Array<{ provider: string; id: string; name?: string }>>([])
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    api.settingsGet()
      .then((s) => { if (alive) setSettings(s) })
      .catch(() => undefined)
    api.models()
      .then((list) => { if (alive) setModels(list) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])

  const commit = async (patch: Partial<KanbanSettingsShape>): Promise<void> => {
    try {
      const next = await api.settingsSet(patch)
      setSettings(next)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1500)
    } catch {
      // keep the previous value
    }
  }

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
      <label className="kb-field kb-field-row">
        <span>{tr('defaultModel')}</span>
        <select
          className="kb-input"
          value={settings.defaultModel}
          onChange={(e) => { void commit({ defaultModel: e.target.value }) }}
        >
          <option value="">—</option>
          {models.map((m) => (
            <option key={m.provider + '/' + m.id} value={m.id}>{m.name ?? m.id}</option>
          ))}
        </select>
      </label>
      {saved && <div className="kb-settings-saved">{tr('saved')}</div>}
    </div>
  )
}