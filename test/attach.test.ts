import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { KanbanRunner } from '../src/server/runner.js'
import type { TaskStore } from '../src/server/task-store.js'
import type { KanbanSettingsFace } from '../src/server/settings.js'

const SID = 'session-test-attach' as SessionId
const WS = '/tmp/kanban-ws'

function makeCtx(services: Record<string, unknown>): Context {
  const map = new Map<string, unknown>(Object.entries(services))
  return {
    get: (name: string) => map.get(name),
  } as unknown as Context
}

function makeRunner(ctx: Context): KanbanRunner {
  const store = {} as TaskStore
  const settings = {
    get: () => ({ maxParallelWorkers: 1 }),
    defaultModelRoute: () => ({}),
  } as unknown as KanbanSettingsFace
  return new KanbanRunner(ctx, store, settings)
}

const attach = (runner: KanbanRunner, ws: string, sid: SessionId): Promise<void> =>
  (runner as unknown as { attachRefinementSession(ws: string, sid: SessionId): Promise<void> }).attachRefinementSession(ws, sid)

describe('KanbanRunner.attachRefinementSession', () => {
  it('attaches the session to the workspace resolved for its cwd', async () => {
    const attachSession = vi.fn(async () => undefined)
    const resolveByPath = vi.fn(async () => ({ attachSession }))
    const runner = makeRunner(makeCtx({ workspace: { resolveByPath } }))
    await attach(runner, WS, SID)
    expect(resolveByPath).toHaveBeenCalledWith(WS)
    expect(attachSession).toHaveBeenCalledWith(SID)
  })

  it('falls back to workspaceRegistry when the workspace service lacks resolveByPath', async () => {
    const attachSession = vi.fn(async () => undefined)
    const resolveByPath = vi.fn(async () => ({ attachSession }))
    const runner = makeRunner(makeCtx({ workspace: { list: () => [] }, workspaceRegistry: { resolveByPath } }))
    await attach(runner, WS, SID)
    expect(resolveByPath).toHaveBeenCalledWith(WS)
    expect(attachSession).toHaveBeenCalledWith(SID)
  })

  it('skips silently when no workspace owns the path', async () => {
    const resolveByPath = vi.fn(async () => undefined)
    const runner = makeRunner(makeCtx({ workspace: { resolveByPath } }))
    await expect(attach(runner, WS, SID)).resolves.toBeUndefined()
    expect(resolveByPath).toHaveBeenCalledWith(WS)
  })

  it('skips silently when the registry is absent', async () => {
    const runner = makeRunner(makeCtx({}))
    await expect(attach(runner, WS, SID)).resolves.toBeUndefined()
  })

  it('does not surface registry failures (best-effort attach)', async () => {
    const resolveByPath = vi.fn(async () => {
      throw new Error('registry down')
    })
    const runner = makeRunner(makeCtx({ resolveByPath }))
    await expect(attach(runner, WS, SID)).resolves.toBeUndefined()
  })
})
