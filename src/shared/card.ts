/**
 * Shared card/plan vocabulary used by both the server half (task store,
 * runners) and the client half (board UI). Pure types: no runtime imports so
 * it survives the client bundle's purity gate and gets inlined into both.
 */

export const CARD_SCHEMA_VERSION = 1

/** Coarse card lifecycle status. */
export type CardStatus =
  | 'draft'
  | 'refining'
  | 'planned'
  | 'queued'
  | 'running'
  | 'completed'
  | 'merging'
  | 'merged'
  | 'error'

/** Error kinds; each maps back to a resume action (retry/stop/delete). */
export type ErrorKind =
  | 'refine_failed'
  | 'phase_failed'
  | 'interrupted'
  | 'merge_failed'
  | 'no_base_branch'
  | 'worktree_failed'
  | 'create_failed'

export interface CardError {
  kind: ErrorKind
  message: string
  at: number
  /** Lane the card was in when it failed (interrupted cards need this). */
  stage?: Lane
}

/** One phase of a plan; phases execute strictly serially, each in its own session. */
export interface PlanPhase {
  id: string
  title: string
  goal: string
}

export interface Plan {
  schemaVersion: number
  title: string
  summary: string
  phases: PlanPhase[]
}

/** One session attempt of a phase (retries append new attempts). */
export interface PhaseAttempt {
  phaseIndex: number
  sessionId: string
  summary?: string
  startedAt: number
  completedAt?: number
}

/** Merge flow steps; retry resumes from the recorded step. */
export type MergeStep = 'prepare' | 'wt-merge' | 'ws-merge' | 'pop' | 'cleanup'

export interface MergeState {
  step: MergeStep
  stashApplied?: boolean
  mergeCommit?: string
}

export interface KanbanCard {
  schemaVersion: number
  id: string
  workspacePath: string
  requirement: string
  /** Optional skill (e.g. `grill-me`) used to drive requirement refinement. */
  skill?: string
  model: string
  /** Provider route for the model (from the modal selection). */
  provider?: string
  status: CardStatus
  error?: CardError
  /** Git-mode: implementation happens in a worktree and merges back. */
  gitMode?: boolean
  baseRef?: string
  baseSha?: string
  branch?: string
  worktreePath?: string
  plan?: Plan
  /** Index of the phase currently running / to resume from. */
  currentPhase: number
  phaseCount: number
  sessions: {
    refinement: string[]
    phases: PhaseAttempt[]
    merge: string[]
  }
  merge?: MergeState
  queuedAt?: number
  createdAt: number
  stoppedAt?: number
}

/** The five board lanes. */
export type Lane = 'demand' | 'queue' | 'running' | 'completed' | 'merged'

/** Model entry for the new-task dropdown. */
export interface ModelOption {
  provider: string
  id: string
  name?: string
}

/** Which kanban session kind a per-type default applies to. */
export type KanbanSessionKind = 'refine' | 'phase' | 'merge'

export interface KanbanSettingsShape {
  maxParallelWorkers: number
  /** Requirement-refinement session defaults. */
  refinementModel: string
  refinementProvider: string
  refinementReasoningEffort: string
  refinementPreset: string
  /** Phase implementation session defaults. */
  phaseModel: string
  phaseProvider: string
  phaseReasoningEffort: string
  phasePreset: string
}
