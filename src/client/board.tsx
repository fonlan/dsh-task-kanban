import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KanbanCard, Lane } from '../shared/card'
import { DROP_RULES, laneOf } from '../shared/lanes'
import { api } from './api'
import { exitBoard, getClient } from './kanban-state'
import { en, zh } from './locales'
import './board.css'

interface BoardProps {
  t?: (key: string, params?: Record<string, unknown>) => string
  useWorkspaces?: (selector: (state: unknown) => unknown) => unknown
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
}

/** The leading `/skill-name` gesture at the start of the requirement input. */
const SKILL_GESTURE = /^\s*\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/

/** Extract a leading `/skill-name` token plus the cleaned remainder. */
function parseSkillGesture(raw: string): { skill?: string; requirement: string } {
  const m = SKILL_GESTURE.exec(raw)
  if (m === null) return { requirement: raw.trim() }
  return { skill: m[1], requirement: raw.slice(m[0].length).trim() }
}

function statusLabel(card: KanbanCard, t: (key: string) => string): string {
  if (card.status === 'error') {
    switch (card.error?.kind) {
      case 'interrupted': return t('interrupted')
      case 'no_base_branch': return t('noBaseBranch')
      case 'worktree_failed': return t('worktreeFailed')
      case 'refine_failed': return t('refineFailed')
      case 'phase_failed': return t('phaseFailed')
      case 'merge_failed': return t('mergeFailed')
      default: return t('createFailed')
    }
  }
  switch (card.status) {
    case 'draft': return t('statusDraft')
    case 'refining': return t('statusRefining')
    case 'planned': return t('statusPlanned')
    case 'queued': return t('statusQueued')
    case 'running': return t('statusRunning')
    case 'completed': return t('statusCompleted')
    case 'merging': return t('statusMerging')
    case 'merged': return t('statusMerged')
  }
}

interface WorkspaceRow {
  workspaceId: string
  path: string
  title: string
}

const LANE_ORDER: Array<{ key: Lane; labelKey: string }> = [
  { key: 'demand', labelKey: 'laneDemand' },
  { key: 'queue', labelKey: 'laneQueue' },
  { key: 'running', labelKey: 'laneRunning' },
  { key: 'completed', labelKey: 'laneCompleted' },
  { key: 'merged', labelKey: 'laneMerged' },
]

const WS_STORAGE_KEY = '@fonlan/dsh-task-kanban:workspace'

export function BoardRoot(props: BoardProps): JSX.Element {
  const t = props.t ?? ((key: string, params?: Record<string, unknown>) => {
    const dict = (zh as Record<string, string>)[key] ?? (en as Record<string, string>)[key]
    if (dict === undefined || params === undefined) return dict ?? key
    return dict.replace(/\{(\w+)\}/g, (m, name: string) => (params[name] as string) ?? m)
  })
  const useWorkspaces = props.useWorkspaces
  const wsState = useWorkspaces !== undefined ? (useWorkspaces((s: unknown) => s) as { items?: WorkspaceRow[] } | undefined) : undefined
  const items: WorkspaceRow[] = wsState?.items ?? []

  const [selectedPath, setSelectedPath] = useState<string>(() => {
    try {
      return localStorage.getItem(WS_STORAGE_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [cards, setCards] = useState<KanbanCard[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)

  useEffect(() => {
    if (selectedPath === '' && items.length > 0) {
      setSelectedPath(items[0].path)
    }
  }, [selectedPath, items])

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 3500)
  }, [])

  const refresh = useCallback(async () => {
    if (selectedPath === '') return
    try {
      setCards(await api.list(selectedPath))
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }, [selectedPath, showToast])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 2500)
    return () => window.clearInterval(timer)
  }, [refresh])

  const byLane = useMemo(() => {
    const map: Record<Lane, KanbanCard[]> = { demand: [], queue: [], running: [], completed: [], merged: [] }
    for (const card of cards) map[laneOf(card)].push(card)
    for (const lane of LANE_ORDER) map[lane.key].sort((a, b) => a.createdAt - b.createdAt)
    return map
  }, [cards])

  const handleDrop = useCallback(async (target: Lane, event: React.DragEvent) => {
    event.preventDefault()
    const cardId = event.dataTransfer.getData('text/plain')
    if (cardId === '') return
    const card = cards.find((c) => c.id === cardId)
    if (card === undefined) return
    if (target === 'queue' && card.status !== 'running' && card.plan === undefined) {
      showToast(t('dragNoPlan'))
      return
    }
    try {
      const result = await api.move(cardId, target)
      if (!result.ok) {
        showToast(t('actionFailed', { message: result.message ?? '' }))
      }
      void refresh()
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }, [cards, refresh, showToast, t])

  const openSession = useCallback((sessionId: string) => {
    const ctx = getClient()
    exitBoard()
    if (ctx === null) return
    try {
      ;(ctx.sessions as { open(id: string): void }).open(sessionId)
    } catch {
      showToast(t('sessionNotListed'))
    }
  }, [showToast, t])

  if (items.length === 0) {
    return (
      <div className="kb-board kb-empty">
        <div className="kb-empty-text">{t('noWorkspace')}</div>
      </div>
    )
  }

  return (
    <div className="kb-board">
      <div className="kb-board-header">
        <div className="kb-board-title">
          <select
            className="kb-ws-select"
            value={selectedPath}
            onChange={(e) => {
              setSelectedPath(e.target.value)
              try {
                localStorage.setItem(WS_STORAGE_KEY, e.target.value)
              } catch {
                // storage unavailable
              }
            }}
          >
            {items.map((w) => (
              <option key={w.workspaceId} value={w.path}>{w.title}</option>
            ))}
          </select>
        </div>
        <div className="kb-board-actions">
          <button type="button" className="kb-btn kb-btn-primary" onClick={() => setNewTaskOpen(true)}>{t('newTask')}</button>
        </div>
      </div>

      <div className="kb-lanes">
        {LANE_ORDER.map((lane) => (
          <div
            key={lane.key}
            className={'kb-lane' + (DROP_RULES[lane.key].length > 0 ? ' kb-lane-drop' : '')}
            onDragOver={(e) => {
              if (DROP_RULES[lane.key].length > 0) e.preventDefault()
            }}
            onDrop={(e) => { void handleDrop(lane.key, e) }}
          >
            <div className="kb-lane-head">
              <span className="kb-lane-title">{t(lane.labelKey)}</span>
              <span className="kb-lane-count">{byLane[lane.key].length}</span>
            </div>
            <div className="kb-lane-body">
              {byLane[lane.key].map((card) => (
                <CardView
                  key={card.id}
                  card={card}
                  t={t}
                  onToggle={() => setDetailId(detailId === card.id ? null : card.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {toast !== null && <div className="kb-toast">{toast}</div>}

      {newTaskOpen && (
        <NewTaskModal
          t={t}
          workspaces={items}
          selectedPath={selectedPath}
          onClose={() => setNewTaskOpen(false)}
          onCreated={() => {
            setNewTaskOpen(false)
            void refresh()
          }}
          onError={(message) => showToast(message)}
        />
      )}

      {detailId !== null && (
        <DetailPanel
          card={cards.find((c) => c.id === detailId) ?? null}
          t={t}
          onClose={() => setDetailId(null)}
          onChanged={() => {
            setDetailId(null)
            void refresh()
          }}
          onToast={showToast}
          onOpenSession={openSession}
        />
      )}
    </div>
  )
}

interface CardViewProps {
  card: KanbanCard
  t: (key: string, params?: Record<string, unknown>) => string
  onToggle: () => void
}

function CardView({ card, t, onToggle }: CardViewProps): JSX.Element {
  const draggable = card.status === 'planned' || card.status === 'queued' || card.status === 'running'
  const title = card.plan !== undefined && card.plan.title !== '' ? card.plan.title : firstLine(card.requirement)
  const badge = statusLabel(card, t)
  const phaseInfo = card.status === 'running' || card.status === 'error'
    ? card.currentPhase < card.phaseCount ? t('phaseProgress', { current: card.currentPhase + 1, total: card.phaseCount }) : ''
    : ''
  return (
    <div
      className={'kb-card' + (card.status === 'error' ? ' kb-card-error' : '') + (card.status === 'running' ? ' kb-card-running' : '')}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', card.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onToggle}
    >
      <div className="kb-card-title">{title}</div>
      <div className="kb-card-meta">
        <span className="kb-card-badge">{badge}</span>
        {phaseInfo !== '' && <span className="kb-card-phase">{phaseInfo}</span>}
        {card.skill !== undefined && card.skill !== '' && <span className="kb-card-skill">/ {card.skill}</span>}
        {card.model !== '' && <span className="kb-card-model">{card.model}</span>}
      </div>
      {card.status === 'error' && card.error !== undefined && (
        <div className="kb-card-error-text">{card.error.message}</div>
      )}
      {card.status === 'running' && card.gitMode === true && (
        <div className="kb-card-worktree">{card.worktreePath ?? ''}</div>
      )}
    </div>
  )
}

interface NewTaskModalProps {
  t: (key: string, params?: Record<string, unknown>) => string
  workspaces: WorkspaceRow[]
  selectedPath: string
  onClose: () => void
  onCreated: () => void
  onError: (message: string) => void
}

function NewTaskModal({ t, workspaces, selectedPath, onClose, onCreated, onError }: NewTaskModalProps): JSX.Element {
  const [requirement, setRequirement] = useState('')
  const [project, setProject] = useState(selectedPath)
  const [model, setModel] = useState('')
  const [modelProvider, setModelProvider] = useState('')
  const [models, setModels] = useState<Array<{ provider: string; id: string; name?: string }>>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api.models()
      .then((list) => { if (alive) setModels(list) })
      .catch(() => { if (alive) setModels([]) })
    api.settingsGet()
      .then((s) => {
        if (alive && s.defaultModel !== '') {
          setModel(s.defaultModel)
        }
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])

  const submit = async (): Promise<void> => {
    if (requirement.trim() === '') {
      onError(t('requirementLabel') + ' ' + t('error'))
      return
    }
    if (project === '') {
      onError(t('noWorkspace'))
      return
    }
    const parsed = parseSkillGesture(requirement)
    setBusy(true)
    try {
      await api.create(project, parsed.requirement, model, modelProvider, parsed.skill)
      onCreated()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
      setBusy(false)
    }
  }

  const activeSkill = parseSkillGesture(requirement).skill

  return (
    <div className="kb-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="kb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="kb-modal-title">{t('newTask')}</div>
        <label className="kb-field">
          <span>{t('requirementLabel')}</span>
          <textarea
            className="kb-input kb-textarea"
            value={requirement}
            placeholder={t('requirementPlaceholder')}
            onChange={(e) => setRequirement(e.target.value)}
          />
          {activeSkill !== undefined ? (
            <span className="kb-field-hint kb-field-hint-skill">{t('skillHint', { skill: activeSkill })}</span>
          ) : (
            <span className="kb-field-hint">{t('skillGestureHint')}</span>
          )}
        </label>
        <label className="kb-field">
          <span>{t('project')}</span>
          <select className="kb-input" value={project} onChange={(e) => setProject(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.workspaceId} value={w.path}>{w.title}</option>
            ))}
          </select>
        </label>
        <label className="kb-field">
          <span>{t('model')}</span>
          <select
            className="kb-input"
            value={model}
            onChange={(e) => {
              const id = e.target.value
              setModel(id)
              const found = models.find((m) => m.id === id)
              setModelProvider(found?.provider ?? '')
            }}
          >
            <option value="">{t('modelPlaceholder')}</option>
            {models.map((m) => (
              <option key={m.provider + '/' + m.id} value={m.id}>{m.name ?? m.id}</option>
            ))}
          </select>
        </label>
        <div className="kb-modal-actions">
          <button type="button" className="kb-btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
          <button type="button" className="kb-btn kb-btn-primary" onClick={() => { void submit() }} disabled={busy}>
            {t('addAndRefine')}
          </button>
        </div>
      </div>
    </div>
  )
}

interface DetailPanelProps {
  card: KanbanCard | null
  t: (key: string, params?: Record<string, unknown>) => string
  onClose: () => void
  onChanged: () => void
  onToast: (message: string) => void
  onOpenSession: (sessionId: string) => void
}

function DetailPanel({ card, t, onClose, onChanged, onToast, onOpenSession }: DetailPanelProps): JSX.Element | null {
  const [busy, setBusy] = useState(false)
  if (card === null) return null

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      onChanged()
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error))
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm(t('deleteConfirm'))) return
    await act(() => api.remove(card!.id))
  }

  return (
    <div className="kb-detail-panel">
      <div className="kb-detail-panel-head">
        <div className="kb-modal-title">
          {card.plan !== undefined && card.plan.title !== '' ? card.plan.title : firstLine(card.requirement)}
          <span className={'kb-detail-status kb-status-' + card.status}>{statusLabel(card, t)}</span>
        </div>
        <button type="button" className="kb-detail-close" aria-label={t('close')} title={t('close')} onClick={onClose}>✕</button>
      </div>

      <div className="kb-detail-panel-body">
        <div className="kb-detail-section">
          <div className="kb-detail-label">{t('requirement')}</div>
          {card.skill !== undefined && card.skill !== '' && (
            <div className="kb-detail-skill">{t('skillBadge', { skill: card.skill })}</div>
          )}
          <div className="kb-detail-text">{card.requirement}</div>
        </div>

        {card.plan !== undefined && (
          <div className="kb-detail-section">
            <div className="kb-detail-label">{t('plan')}</div>
            <div className="kb-detail-plan">
              <div className="kb-plan-summary">{card.plan.summary}</div>
              <ol className="kb-plan-phases">
                {card.plan.phases.map((phase, i) => (
                  <li key={phase.id} className={'kb-plan-phase' + (i === card.currentPhase && card.status === 'running' ? ' kb-plan-phase-current' : '')}>
                    <div className="kb-plan-phase-head">
                      <span className="kb-plan-phase-title">{phase.title}</span>
                      <span className="kb-plan-phase-id">{phase.id}</span>
                    </div>
                    <div className="kb-plan-phase-goal">{phase.goal}</div>
                    <PhaseSessions phaseIndex={i} card={card} t={t} onOpenSession={onOpenSession} />
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}

        {card.sessions.refinement.length > 0 && (
          <div className="kb-detail-section">
            <div className="kb-detail-label">{t('refinementLabel')}</div>
            <div className="kb-session-links">
              {card.sessions.refinement.map((sid) => (
                <button key={sid} type="button" className="kb-btn kb-btn-small" onClick={() => onOpenSession(sid)}>
                  {t('openSession')} · {sid.slice(0, 13)}
                </button>
              ))}
            </div>
          </div>
        )}

        {card.status === 'error' && card.error !== undefined && (
          <div className="kb-detail-section kb-detail-error">
            <div className="kb-detail-label">{t('error')}</div>
            <div className="kb-detail-text">{card.error.message}</div>
          </div>
        )}

        {card.merge?.mergeCommit !== undefined && (
          <div className="kb-detail-section">
            <div className="kb-detail-label">{t('mergeLabel')}</div>
            <div className="kb-detail-text">{t('commitLabel')} {card.merge.mergeCommit.slice(0, 12)}</div>
          </div>
        )}

        <div className="kb-modal-actions">
          {card.status === 'error' && (
            <button type="button" className="kb-btn kb-btn-primary" disabled={busy} onClick={() => { void act(() => api.retry(card!.id)) }}>
              {t('retry')}
            </button>
          )}
          {(card.status === 'running' || card.status === 'merging') && (
            <button type="button" className="kb-btn" disabled={busy} onClick={() => { void act(() => api.stop(card!.id)) }}>
              {t('stop')}
            </button>
          )}
          {card.status !== 'running' && card.status !== 'refining' && card.status !== 'merging' && (
            <button type="button" className="kb-btn kb-btn-danger" disabled={busy} onClick={() => { void remove() }}>
              {t('delete')}
            </button>
          )}
          <button type="button" className="kb-btn" onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  )
}

function PhaseSessions({ phaseIndex, card, t, onOpenSession }: {
  phaseIndex: number
  card: KanbanCard
  t: (key: string) => string
  onOpenSession: (sessionId: string) => void
}): JSX.Element | null {
  const attempts = card.sessions.phases.filter((a) => a.phaseIndex === phaseIndex)
  if (attempts.length === 0) return null
  return (
    <div className="kb-session-links">
      {attempts.map((a) => (
        <span key={a.sessionId} className="kb-session-attempt">
          <button type="button" className="kb-btn kb-btn-small" onClick={() => onOpenSession(a.sessionId)}>
            {t('openSession')} · {a.sessionId.slice(0, 13)}
          </button>
          {a.summary !== undefined && <span className="kb-session-summary">{a.summary}</span>}
        </span>
      ))}
    </div>
  )
}