import type { Context } from '@deepseek-ai/cordis'
import type { ModelOption } from '../shared/card.js'

/** Available models from every registered LLM provider (advisory catalog). */
export async function listModels(ctx: Context): Promise<ModelOption[]> {
  const llm = ctx.get('llm') as
    | { listProviders(): Array<{ id: string; name?: string }>; listModels(provider: string): Promise<Array<{ id: string; name?: string }>> }
    | undefined
  if (llm === undefined) return []
  const out: ModelOption[] = []
  for (const provider of llm.listProviders()) {
    try {
      const models = await llm.listModels(provider.id)
      for (const m of models) out.push({ provider: provider.id, id: m.id, name: m.name ?? m.id })
    } catch {
      // provider without a model catalog: skip
    }
  }
  return out
}

/** One selectable reasoning effort of a model (display vocabulary for the settings picker). */
export interface ReasoningEffortOption {
  id: string
  name: string
  description?: string
}

export interface ReasoningOptions {
  efforts: ReasoningEffortOption[]
  defaultEffort?: string
}

/**
 * Resolve the adapter-owned reasoning efforts of one exact provider/model
 * route. On-demand (one model at a time) so the settings picker can offer the
 * levels the selected model actually supports; failures yield an empty list.
 */
export async function reasoningOptions(ctx: Context, provider: string, model: string): Promise<ReasoningOptions> {
  const llm = ctx.get('llm') as
    | { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
      reasoning?: { efforts?: Array<{ id: unknown; name: string; description?: string }>; defaultEffort?: unknown }
    }> }
    | undefined
  if (llm === undefined) return { efforts: [] }
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const efforts = (info.reasoning?.efforts ?? []).map((e) => ({
      id: String(e.id),
      name: e.name,
      ...(e.description !== undefined ? { description: e.description } : {}),
    }))
    return {
      efforts,
      ...(info.reasoning?.defaultEffort !== undefined ? { defaultEffort: String(info.reasoning.defaultEffort) } : {}),
    }
  } catch {
    return { efforts: [] }
  }
}
