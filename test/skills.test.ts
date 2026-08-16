import { describe, expect, it, vi } from 'vitest'
import { loadCardSkill, parseSkillGesture, skillInvocationMessage, validSkillName, type SkillRegistryFace } from '../src/server/skills.js'

describe('parseSkillGesture', () => {
  it('extracts a leading skill gesture and strips it', () => {
    expect(parseSkillGesture('/grill-me 帮我规划一个登录功能')).toEqual({
      skill: 'grill-me',
      requirement: '帮我规划一个登录功能',
    })
  })

  it('accepts leading whitespace before the gesture', () => {
    expect(parseSkillGesture('  /grill-me 需求')).toEqual({ skill: 'grill-me', requirement: '需求' })
  })

  it('accepts a newline before the gesture', () => {
    expect(parseSkillGesture('\n/grill-me\n需求')).toEqual({ skill: 'grill-me', requirement: '需求' })
  })

  it('requires the gesture at the very start', () => {
    // mid-text slash tokens are ordinary prose
    expect(parseSkillGesture('帮我看看 /grill-me 怎么用')).toEqual({ skill: undefined, requirement: '帮我看看 /grill-me 怎么用' })
    // path-looking tokens are not matched (the second slash breaks the token)
    expect(parseSkillGesture('/usr/bin 安装')).toEqual({ skill: undefined, requirement: '/usr/bin 安装' })
  })

  it('rejects non-kebab-case names', () => {
    expect(parseSkillGesture('/GrillMe x').skill).toBeUndefined()
    expect(parseSkillGesture('/grill_me x').skill).toBeUndefined()
  })

  it('returns the trimmed requirement when no gesture is present', () => {
    expect(parseSkillGesture('  普通需求  ')).toEqual({ skill: undefined, requirement: '普通需求' })
  })

  it('keeps the empty requirement when only a gesture is given', () => {
    expect(parseSkillGesture('/grill-me')).toEqual({ skill: 'grill-me', requirement: '' })
  })
})

describe('validSkillName', () => {
  it('accepts kebab-case names', () => {
    expect(validSkillName('grill-me')).toBe(true)
    expect(validSkillName('html-ppt')).toBe(true)
    expect(validSkillName('plain')).toBe(true)
  })

  it('rejects malformed names', () => {
    expect(validSkillName('Grill Me')).toBe(false)
    expect(validSkillName('grill_me')).toBe(false)
    expect(validSkillName('')).toBe(false)
    expect(validSkillName('/grill-me')).toBe(false)
  })
})

describe('skillInvocationMessage', () => {
  it('builds an instructions-form user message with the skill-invocation source', () => {
    const message = skillInvocationMessage({
      name: 'grill-me',
      provider: 'local',
      content: 'Run a `/grilling` session.',
    })
    expect(message.role).toBe('user')
    expect(message.source).toEqual({ kind: 'skill-invocation', name: 'grill-me', form: 'instructions' })
    const text = message.content[0]
    expect(text.type).toBe('text')
    if (text.type === 'text') {
      expect(text.text).toContain('<skill_content name="grill-me">')
      expect(text.text).toContain('Run a `/grilling` session.')
    }
  })
})

describe('loadCardSkill', () => {
  it('loads a user-invocable skill through the registry face', async () => {
    const registry = {
      get: vi.fn(async () => ({
        name: 'grill-me',
        provider: 'local',
        content: 'Run a grilling session.',
        invocation: { modelInvocable: false, userInvocable: true },
      })),
    } as unknown as SkillRegistryFace
    const ctx = { get: (name: string) => (name === 'skills' ? registry : undefined) } as never
    const skill = await loadCardSkill(ctx, 'grill-me', '/tmp/ws', { id: 'agent' })
    expect(registry.get).toHaveBeenCalledWith('grill-me', { cwd: '/tmp/ws', scope: { id: 'agent' } })
    expect(skill?.name).toBe('grill-me')
  })

  it('returns undefined for an unknown name', async () => {
    const registry = { get: vi.fn(async () => undefined) } as unknown as SkillRegistryFace
    const ctx = { get: (name: string) => (name === 'skills' ? registry : undefined) } as never
    await expect(loadCardSkill(ctx, 'nope', '/tmp', {})).resolves.toBeUndefined()
  })

  it('returns undefined when the registry is absent', async () => {
    await expect(loadCardSkill({} as never, 'grill-me', '/tmp', {})).resolves.toBeUndefined()
  })

  it('returns undefined when the skill is not user-invocable (model-only)', async () => {
    const registry = {
      get: vi.fn(async () => ({
        name: 'model-only',
        provider: 'local',
        content: 'x',
        invocation: { modelInvocable: true, userInvocable: false },
      })),
    } as unknown as SkillRegistryFace
    const ctx = { get: (name: string) => (name === 'skills' ? registry : undefined) } as never
    await expect(loadCardSkill(ctx, 'model-only', '/tmp', {})).resolves.toBeUndefined()
  })
})