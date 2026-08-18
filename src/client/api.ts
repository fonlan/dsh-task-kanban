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

/** One row of the host `skill.list` catalog (same shape DSH's chat autocomplete uses). */
export interface SkillOption {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
}

/**
 * Call the host gateway's `skill.list` unary RPC over the same-origin HTTP
 * bridge (the exact wire shape DSH's chat input uses for its /-autocomplete).
 * The requested `sessionId` scopes the catalog to that session's agent
 * preset, which is where the filesystem skill roots are registered.
 */
export async function gatewaySkillList(sessionId: string): Promise<SkillOption[]> {
  let response: Response
  try {
    response = await fetch('/api/skill.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `task-kanban-${Math.random().toString(36).slice(2)}`,
        method: 'skill.list',
        payload: { sessionId },
      }),
    })
  } catch (error) {
    throw new KanbanApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed: { type?: string; result?: { ok?: boolean; value?: { skills?: SkillOption[] }; error?: { code?: string; message?: string } } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.type !== 'server-response' || parsed.result?.ok !== true) {
    throw new KanbanApiError(
      parsed?.result?.error?.code ?? 'http',
      parsed?.result?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.result.value?.skills ?? []
}

/** One row of the host `agentPresets.list()` roster. */
export interface PresetOption {
  id: string
  name?: string
  description?: string
}

/** Reasoning efforts of one provider/model route (`reasoning.options`). */
export interface ReasoningOptions {
  efforts: Array<{ id: string; name: string; description?: string }>
  defaultEffort?: string
  /** Client-side marker: the fetch failed; the stored effort must be kept. */
  failed?: boolean
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
  presets: () => call<PresetOption[]>('presets.list'),
  reasoningOptions: (provider: string, model: string) =>
    call<ReasoningOptions>('reasoning.options', { provider, model }),
}
