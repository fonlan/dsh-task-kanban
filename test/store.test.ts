import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskStore } from '../src/server/task-store.js'

let wsPath: string
let store: TaskStore

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kanban-store-'))
  wsPath = join(dir, 'ws')
  store = new TaskStore()
})
afterEach(async () => {
  // TaskStore derives paths from the workspace path; clean its parent
  const parent = wsPath.replace(/\/ws$/, '')
  await rm(parent, { recursive: true, force: true })
})

describe('TaskStore', () => {
  it('creates, lists and reads cards', async () => {
    const card = await store.create({ workspacePath: wsPath, requirement: 'r1', model: 'm1' })
    const card2 = await store.create({ workspacePath: wsPath, requirement: 'r2', model: 'm2' })
    const all = await store.list(wsPath)
    expect(all.map((c) => c.id).sort()).toEqual([card.id, card2.id].sort())
    const got = await store.get(wsPath, card.id)
    expect(got?.requirement).toBe('r1')
  })

  it('mutates under the card lock and persists', async () => {
    const card = await store.create({ workspacePath: wsPath, requirement: 'r', model: 'm' })
    await store.mutate(card.id, (c) => { c.status = 'queued'; c.queuedAt = 123 }, wsPath)
    const fresh = new TaskStore()
    const reread = await fresh.get(wsPath, card.id)
    expect(reread?.status).toBe('queued')
    expect(reread?.queuedAt).toBe(123)
  })

  it('removes cards', async () => {
    const card = await store.create({ workspacePath: wsPath, requirement: 'r', model: 'm' })
    await store.remove(wsPath, card.id)
    expect(await store.get(wsPath, card.id)).toBeUndefined()
    expect(await store.list(wsPath)).toHaveLength(0)
  })

  it('lists an absent workspace as empty', async () => {
    expect(await store.list(join(wsPath, 'nope'))).toHaveLength(0)
  })
})
