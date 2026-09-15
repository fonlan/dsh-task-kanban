import { afterEach, describe, expect, it, vi } from 'vitest'
import { gatewaySkillList, KanbanApiError } from '../src/client/api.js'

interface CapturedCall {
  url: string
  init: RequestInit
  body: { type?: string; rpcId?: string; method?: string; payload?: unknown }
}

/** Stub global fetch with one canned response and capture the request. */
function stubFetch(response: { ok?: boolean; status?: number; json?: unknown }): CapturedCall {
  const captured: CapturedCall = { url: '', init: {}, body: {} }
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    captured.url = url
    captured.init = init
    captured.body = JSON.parse(String(init.body)) as CapturedCall['body']
    return Promise.resolve({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: () => Promise.resolve(response.json),
    })
  })
  return captured
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gatewaySkillList', () => {
  it('addresses the canonical skills/list endpoint with named args', async () => {
    const call = stubFetch({ json: { type: 'server-response', rpcId: 'x', result: { ok: true, value: { skills: [] } } } })

    await gatewaySkillList('session-1')

    // DSH ≥0.1.5: `<namespace>/<method>` path, never the legacy dotted `skill.list`.
    expect(call.url).toBe('/api/skills/list')
    expect(call.body.method).toBe('skills/list')
    // Named wire arguments ride a single `args` field; the descriptor's
    // parameter wire name is `request`.
    expect(call.body.payload).toEqual({ args: { request: { sessionId: 'session-1' } } })
    expect(call.body.type).toBe('client-request')
    expect(typeof call.body.rpcId).toBe('string')
  })

  it('returns the catalog rows', async () => {
    const skills = [{ name: 'grill-me', description: 'grill', modelInvocable: true }]
    stubFetch({ json: { type: 'server-response', rpcId: 'x', result: { ok: true, value: { skills } } } })

    await expect(gatewaySkillList('session-1')).resolves.toEqual(skills)
  })

  it('surfaces a gateway failure as a KanbanApiError', async () => {
    stubFetch({
      json: {
        type: 'server-response',
        rpcId: 'x',
        result: { ok: false, error: { code: 'session/not-found', message: 'no session session-1' } },
      },
    })

    await expect(gatewaySkillList('session-1')).rejects.toThrowError(
      new KanbanApiError('session/not-found', 'no session session-1'),
    )
  })

  it('surfaces a transport 404 (the legacy endpoint) as a KanbanApiError', async () => {
    stubFetch({ ok: false, status: 404, json: undefined })

    await expect(gatewaySkillList('session-1')).rejects.toThrowError(KanbanApiError)
  })
})
