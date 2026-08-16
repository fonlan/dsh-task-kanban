import { describe, expect, it } from 'vitest'
import { validatePlan } from '../src/shared/plan.js'

describe('validatePlan', () => {
  it('accepts a valid single-phase plan', () => {
    const result = validatePlan({
      title: 't',
      summary: 's',
      phases: [{ id: 'p1', title: 'Phase 1', goal: 'Goal 1' }],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.phases).toHaveLength(1)
    }
  })

  it('rejects empty phases', () => {
    const result = validatePlan({ title: 't', summary: 's', phases: [] })
    expect(result.ok).toBe(false)
  })

  it('rejects duplicate phase ids', () => {
    const result = validatePlan({
      title: 't',
      summary: 's',
      phases: [
        { id: 'p1', title: 'a', goal: 'b' },
        { id: 'p1', title: 'c', goal: 'd' },
      ],
    })
    expect(result.ok).toBe(false)
  })

  it('rejects missing fields', () => {
    expect(validatePlan({ title: '', summary: 's', phases: [{ id: 'p1', title: 'a', goal: 'b' }] }).ok).toBe(false)
    expect(validatePlan({ title: 't', summary: 's', phases: [{ id: 'p1', title: '', goal: 'b' }] }).ok).toBe(false)
    expect(validatePlan({ title: 't', summary: 's', phases: 'x' }).ok).toBe(false)
  })

  it('accepts multi-phase plans in order', () => {
    const result = validatePlan({
      title: 't',
      summary: 's',
      phases: [
        { id: 'p1', title: 'a', goal: 'b' },
        { id: 'p2', title: 'c', goal: 'd' },
        { id: 'p3', title: 'e', goal: 'f' },
      ],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plan.phases.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })
})
