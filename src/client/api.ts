import type { KanbanCard, KanbanSettingsShape, Lane, ModelOption } from '../shared/card'

export class KanbanApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

async function call<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/plugins/@fonlan/dsh-task-kanban/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new KanbanApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new KanbanApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

export const api = {
  list: (workspacePath: string) => call<KanbanCard[]>('list', { workspacePath }),
  create: (workspacePath: string, requirement: string, model: string, provider?: string, skill?: string) =>
    call<KanbanCard>('create', { workspacePath, requirement, model, provider, ...(skill !== undefined && skill !== '' ? { skill } : {}) }),
  move: (cardId: string, toLane: Lane) => call<{ ok: boolean; message?: string }>('move', { cardId, toLane }),
  stop: (cardId: string) => call<{ ok: boolean; message?: string }>('stop', { cardId }),
  retry: (cardId: string) => call<{ ok: boolean; message?: string }>('retry', { cardId }),
  remove: (cardId: string) => call<{ ok: boolean; message?: string }>('remove', { cardId }),
  settingsGet: () => call<KanbanSettingsShape>('settings.get'),
  settingsSet: (patch: Partial<KanbanSettingsShape>) => call<KanbanSettingsShape>('settings.set', patch),
  models: () => call<ModelOption[]>('models.list'),
}