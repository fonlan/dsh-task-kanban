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
