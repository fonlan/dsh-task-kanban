/**
 * Plan payload validation (shared by the write-back tool and tests).
 */
import type { Plan } from './card.js'

export type ValidatePlanResult =
  | { ok: true; plan: Plan }
  | { ok: false; message: string }

export function validatePlan(input: unknown): ValidatePlanResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, message: '计划必须是对象' }
  }
  const obj = input as Record<string, unknown>
  if (typeof obj.title !== 'string' || obj.title.trim() === '') {
    return { ok: false, message: 'title 不能为空' }
  }
  if (typeof obj.summary !== 'string' || obj.summary.trim() === '') {
    return { ok: false, message: 'summary 不能为空' }
  }
  if (!Array.isArray(obj.phases) || obj.phases.length === 0) {
    return { ok: false, message: 'phases 必须是非空数组' }
  }
  const seen = new Set<string>()
  for (const phase of obj.phases) {
    if (typeof phase !== 'object' || phase === null) {
      return { ok: false, message: 'phase 必须是对象' }
    }
    const p = phase as Record<string, unknown>
    if (typeof p.id !== 'string' || typeof p.title !== 'string' || typeof p.goal !== 'string') {
      return { ok: false, message: '每个 phase 都必须包含 id/title/goal' }
    }
    if (p.id.trim() === '' || p.title.trim() === '' || p.goal.trim() === '') {
      return { ok: false, message: '每个 phase 的 id/title/goal 都不能为空' }
    }
    if (seen.has(p.id)) {
      return { ok: false, message: `phase id 重复: ${p.id}` }
    }
    seen.add(p.id)
  }
  return {
    ok: true,
    plan: {
      schemaVersion: 1,
      title: obj.title,
      summary: obj.summary,
      phases: (obj.phases as Array<{ id: string; title: string; goal: string }>).map((p) => ({
        id: p.id,
        title: p.title,
        goal: p.goal,
      })),
    },
  }
}
