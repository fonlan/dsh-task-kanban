import { describe, expect, it } from 'vitest'
import { canDrop, DROP_RULES, laneOf } from '../src/shared/lanes.js'
import type { KanbanCard } from '../src/shared/card.js'

function card(overrides: Partial<KanbanCard>): KanbanCard {
  return {
    schemaVersion: 1,
    id: 'x',
    workspacePath: '/tmp',
    requirement: 'r',
    model: 'm',
    status: 'planned',
    currentPhase: 0,
    phaseCount: 0,
    sessions: { refinement: [], phases: [], merge: [] },
    createdAt: 0,
    ...overrides,
  }
}

describe('laneOf', () => {
  it('maps statuses to lanes', () => {
    expect(laneOf(card({ status: 'planned' }))).toBe('demand')
    expect(laneOf(card({ status: 'queued' }))).toBe('queue')
    expect(laneOf(card({ status: 'running' }))).toBe('running')
    expect(laneOf(card({ status: 'completed' }))).toBe('completed')
    expect(laneOf(card({ status: 'merging' }))).toBe('completed')
    expect(laneOf(card({ status: 'merged' }))).toBe('merged')
  })

  it('uses the recorded stage for interrupted cards', () => {
    expect(laneOf(card({ status: 'error', error: { kind: 'interrupted', stage: 'running', message: 'm', at: 0 } }))).toBe('running')
    expect(laneOf(card({ status: 'error', error: { kind: 'interrupted', stage: 'demand', message: 'm', at: 0 } }))).toBe('demand')
  })

  it('maps error kinds without a stage', () => {
    expect(laneOf(card({ status: 'error', error: { kind: 'phase_failed', message: 'm', at: 0 } }))).toBe('running')
    expect(laneOf(card({ status: 'error', error: { kind: 'merge_failed', message: 'm', at: 0 } }))).toBe('completed')
    expect(laneOf(card({ status: 'error', error: { kind: 'refine_failed', message: 'm', at: 0 } }))).toBe('demand')
  })
})

describe('drag rules', () => {
  it('queue accepts demand and running; demand accepts queue', () => {
    expect(canDrop('demand', 'queue')).toBe(true)
    expect(canDrop('running', 'queue')).toBe(true)
    expect(canDrop('queue', 'demand')).toBe(true)
    expect(canDrop('queue', 'running')).toBe(false)
    expect(canDrop('running', 'completed')).toBe(false)
  })

  it('every lane has a rule entry', () => {
    for (const lane of ['demand', 'queue', 'running', 'completed', 'merged']) {
      expect(Array.isArray(DROP_RULES[lane as keyof typeof DROP_RULES])).toBe(true)
    }
  })
})
