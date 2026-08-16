import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CARD_SCHEMA_VERSION, type KanbanCard } from '../shared/card.js'

const TASKS_REL = ['.dsh', 'task-kanban', 'tasks']

/**
 * File-backed task store: one JSON file per card under
 * `<workspace>/.dsh/task-kanban/tasks/<id>.json`. In-process cache plus
 * atomic (tmp+rename) writes, with a per-card mutex so worker and RPC
 * mutations never interleave.
 */
export class TaskStore {
  private cache = new Map<string, KanbanCard>()
  private locks = new Map<string, Promise<unknown>>()

  private taskDir(workspacePath: string): string {
    return join(workspacePath, ...TASKS_REL)
  }

  private fileOf(workspacePath: string, id: string): string {
    return join(this.taskDir(workspacePath), `${id}.json`)
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(key, next.catch(() => undefined))
    return next
  }

  async list(workspacePath: string): Promise<KanbanCard[]> {
    const dir = this.taskDir(workspacePath)
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return []
    }
    const out: KanbanCard[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const id = f.slice(0, -5)
      const card = await this.get(workspacePath, id)
      if (card !== undefined) out.push(card)
    }
    out.sort((a, b) => a.createdAt - b.createdAt)
    return out
  }

  async get(workspacePath: string, id: string): Promise<KanbanCard | undefined> {
    const cached = this.cache.get(id)
    if (cached !== undefined && cached.workspacePath === workspacePath) return cached
    try {
      const raw = await readFile(this.fileOf(workspacePath, id), 'utf8')
      const card = JSON.parse(raw) as KanbanCard
      this.cache.set(id, card)
      return card
    } catch {
      return undefined
    }
  }

  async create(input: {
    workspacePath: string
    requirement: string
    model: string
    provider?: string
    status?: KanbanCard['status']
  }): Promise<KanbanCard> {
    const id = randomUUID()
    const card: KanbanCard = {
      schemaVersion: CARD_SCHEMA_VERSION,
      id,
      workspacePath: input.workspacePath,
      requirement: input.requirement,
      model: input.model,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      status: input.status ?? 'draft',
      currentPhase: 0,
      phaseCount: 0,
      sessions: { refinement: [], phases: [], merge: [] },
      createdAt: Date.now(),
    }
    await this.write(card)
    return card
  }

  /** Run a mutation under the card's lock; returns the updated card. */
  async mutate(
    id: string,
    fn: (card: KanbanCard) => void | Promise<void>,
    workspacePath?: string,
  ): Promise<KanbanCard | undefined> {
    return this.withLock(id, async () => {
      let card = this.cache.get(id)
      if ((card === undefined || (workspacePath !== undefined && card.workspacePath !== workspacePath)) && workspacePath !== undefined) {
        card = await this.get(workspacePath, id)
      }
      if (card === undefined) return undefined
      await fn(card)
      await this.write(card)
      return card
    })
  }

  private async write(card: KanbanCard): Promise<void> {
    const dir = this.taskDir(card.workspacePath)
    await mkdir(dir, { recursive: true })
    const file = this.fileOf(card.workspacePath, card.id)
    const tmp = file + '.tmp'
    await writeFile(tmp, JSON.stringify(card, null, 2), 'utf8')
    await rename(tmp, file)
    this.cache.set(card.id, card)
  }

  async remove(workspacePath: string, id: string): Promise<void> {
    await this.withLock(id, async () => {
      this.cache.delete(id)
      try {
        await rm(this.fileOf(workspacePath, id), { force: true })
      } catch {
        // already gone
      }
    })
  }
}