/**
 * Lane mapping and drag rules (shared by the board UI and tests).
 */
import type { KanbanCard, Lane } from './card.js'

/** Which lane a card renders in, based on status + error stage. */
export function laneOf(card: KanbanCard): Lane {
  if (card.status === 'error') {
    if (card.error?.stage !== undefined) return card.error.stage
    const kind = card.error?.kind
    if (kind === 'phase_failed' || kind === 'no_base_branch' || kind === 'worktree_failed') return 'running'
    if (kind === 'merge_failed') return 'completed'
    return 'demand'
  }
  switch (card.status) {
    case 'draft':
    case 'refining':
    case 'planned':
      return 'demand'
    case 'queued':
      return 'queue'
    case 'running':
      return 'running'
    case 'completed':
    case 'merging':
      return 'completed'
    case 'merged':
      return 'merged'
  }
}

/** Lanes a drop onto `to` may come from. */
export const DROP_RULES: Record<Lane, Lane[]> = {
  demand: ['queue'],
  queue: ['demand', 'running'],
  running: [],
  completed: [],
  merged: [],
}

export function canDrop(from: Lane, to: Lane): boolean {
  return DROP_RULES[to].includes(from)
}
