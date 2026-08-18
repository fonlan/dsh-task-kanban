import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { KanbanRunner } from '../src/server/runner.js'
import type { KanbanCard, KanbanSessionKind } from '../src/shared/card.js'
import type { TaskStore } from '../src/server/task-store.js'
import type { KanbanSettingsFace, KanbanSessionDefaults } from '../src/server/settings.js'

const WS = '/tmp/kanban-ws'

function card(model: string, provider?: string): KanbanCard {
  return {
    schemaVersion: 1,
    id: 'c1',
    workspacePath: WS,
    requirement: 'r',
    model,
    ...(provider !== undefined ? { provider } : {}),
    status: 'planned',
    currentPhase: 0,
    phaseCount: 0,
    sessions: { refinement: [], phases: [], merge: [] },
    createdAt: 0,
  }
}

function makeRunner(card: KanbanCard, sessionDefaults: Partial<Record<KanbanSessionKind, KanbanSessionDefaults>>): KanbanRunner {
  const store = { get: async () => card } as unknown as TaskStore
  const empty: KanbanSessionDefaults = { model: '', provider: '', reasoningEffort: '', preset: '' }
  const settings = {
    get: () => ({ maxParallelWorkers: 1 }),
    defaultModelRoute: () => ({ provider: 'host-provider', model: 'host-model' }),
    sessionDefaults: (kind: KanbanSessionKind) => ({ ...empty, ...sessionDefaults[kind] }),
  } as unknown as KanbanSettingsFace
  return new KanbanRunner({} as Context, store, settings)
}

const route = (runner: KanbanRunner, kind: KanbanSessionKind): Promise<{ provider?: string; model?: string; reasoningEffort?: string }> =>
  (runner as unknown as {
    modelRoute(cardId: string, ws: string, kind: KanbanSessionKind): Promise<{ provider?: string; model?: string; reasoningEffort?: string }>
  }).modelRoute('c1', WS, kind)

describe('KanbanRunner.modelRoute', () => {
  it('prefers the card model for every kind', async () => {
    const runner = makeRunner(card('card-model', 'card-provider'), {
      refine: { model: 'refine-model', provider: 'refine-provider', reasoningEffort: 'high', preset: '' },
    })
    for (const kind of ['refine', 'phase', 'merge'] as const) {
      await expect(route(runner, kind)).resolves.toEqual({ provider: 'card-provider', model: 'card-model' })
    }
  })

  it('uses the refine defaults for refinement sessions', async () => {
    const runner = makeRunner(card(''), {
      refine: { model: 'refine-model', provider: 'refine-provider', reasoningEffort: 'high', preset: '' },
      phase: { model: 'phase-model', provider: 'phase-provider', reasoningEffort: 'low', preset: '' },
    })
    await expect(route(runner, 'refine')).resolves.toEqual({ provider: 'refine-provider', model: 'refine-model', reasoningEffort: 'high' })
  })

  it('uses the phase defaults for phase sessions', async () => {
    const runner = makeRunner(card(''), {
      refine: { model: 'refine-model', provider: 'refine-provider', reasoningEffort: 'high', preset: '' },
      phase: { model: 'phase-model', provider: 'phase-provider', reasoningEffort: 'low', preset: '' },
    })
    await expect(route(runner, 'phase')).resolves.toEqual({ provider: 'phase-provider', model: 'phase-model', reasoningEffort: 'low' })
  })

  it('omits the effort when the kind default leaves it empty', async () => {
    const runner = makeRunner(card(''), {
      refine: { model: 'refine-model', provider: 'refine-provider', reasoningEffort: '', preset: '' },
    })
    await expect(route(runner, 'refine')).resolves.toEqual({ provider: 'refine-provider', model: 'refine-model' })
  })

  it('ignores kind defaults for merge sessions (legacy chain)', async () => {
    const runner = makeRunner(card(''), {
      phase: { model: 'phase-model', provider: 'phase-provider', reasoningEffort: 'low', preset: '' },
    })
    // No card model, no kind defaults for merge → host route.
    await expect(route(runner, 'merge')).resolves.toEqual({ provider: 'host-provider', model: 'host-model' })
  })

  it('falls back to the host default route when no defaults apply', async () => {
    const runner = makeRunner(card(''), {})
    for (const kind of ['refine', 'phase', 'merge'] as const) {
      await expect(route(runner, kind)).resolves.toEqual({ provider: 'host-provider', model: 'host-model' })
    }
  })
})
