import { afterEach, describe, expect, it, vi } from 'vitest'

/** Import the resolver with a given shape of `@deepseek-ai/dsh-client-ui-primitives`. */
async function loadResolver(exports: Record<string, unknown>): Promise<unknown> {
  vi.resetModules()
  vi.doMock('@deepseek-ai/dsh-client-ui-primitives', () => exports)
  const mod = await import('../src/client/icons')
  return mod.ChecklistIcon
}

afterEach(() => {
  vi.doUnmock('@deepseek-ai/dsh-client-ui-primitives')
  vi.resetModules()
})

describe('ChecklistIcon resolution', () => {
  it('prefers the DSH 0.1.7 stroke-weight export', async () => {
    const regular = (): null => null
    const legacy = (): null => null
    expect(await loadResolver({ IconChecklistOutlineRegular: regular, IconChecklistOutline14: legacy })).toBe(regular)
  })

  it('falls back to the legacy size-suffixed export', async () => {
    const legacy = (): null => null
    expect(await loadResolver({ IconChecklistOutline14: legacy })).toBe(legacy)
  })

  it('never resolves to undefined when the shell exports no known name', async () => {
    // A missing named import used to reach React as `undefined`, which crashed
    // the whole slot entry that renders the board entry — the button vanished.
    const icon = await loadResolver({ SomethingElse: (): null => null })
    expect(typeof icon).toBe('function')
  })

  it('ignores non-component exports under a known name', async () => {
    const icon = await loadResolver({ IconChecklistOutlineRegular: 'not-a-component' })
    expect(typeof icon).toBe('function')
  })
})
