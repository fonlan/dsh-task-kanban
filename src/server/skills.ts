/**
 * Skill wiring for requirement refinement.
 *
 * A task card may carry a skill name (e.g. `grill-me`) chosen in the
 * create-task requirement input via a leading `/skill-name` gesture, matching
 * the harness's user-invocation convention (the same whitespace-bounded token
 * shape `tool-skill` scans for). The server strips the gesture from the stored
 * requirement, records the skill on the card, and injects the canonical
 * `renderSkillContent` block into the refinement session as an instructions-
 * form user message with the harness's `skill-invocation` source, so the
 * transcript UI renders it exactly like a user-invoked skill in chat.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isSkillName, isUserInvocable, renderSkillContent, type SkillDefinition, type SkillSummary } from '@deepseek-ai/dsh-skill'

/**
 * The public skill-name gesture shape: a whitespace-bounded `/name` token
 * matching the grammar `tool-skill` uses (kebab-case letters/digits), at the
 * very start of the input (leading whitespace allowed). A second `/` or
 * non-boundary character breaks the match, keeping file paths (`/usr/bin`)
 * and fractions (`5/8`) out.
 */
const SKILL_GESTURE = /^\s*\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/

/** A parsed leading skill gesture: the skill name plus the cleaned requirement. */
export interface SkillGestureParse {
  /** The skill name from the leading `/name` token, if the input led with one. */
  skill?: string
  /** The requirement text with the leading gesture removed. */
  requirement: string
}

/**
 * Extract a leading `/skill-name` gesture from raw create-task input. Only a
 * token at the very start selects a skill; tokens later in the text are
 * ordinary requirement prose (the user might legitimately mention paths or
 * fractions). The name is grammar-validated but not registry-checked here —
 * unknown names surface as a refinement error with a clear message.
 */
export function parseSkillGesture(raw: string): SkillGestureParse {
  const m = SKILL_GESTURE.exec(raw)
  if (m === null) return { requirement: raw.trim() }
  return {
    skill: m[1],
    requirement: raw.slice(m[0].length).trim(),
  }
}

/**
 * The minimal view of the hosted skill registry the plugin needs: list for a
 * summary lookup and get for a full body, both honoring the calling scope.
 */
export interface SkillRegistryFace {
  list(options?: { cwd?: string; scope?: unknown }): Promise<SkillSummary[]>
  get(name: string, options?: { cwd?: string; scope?: unknown }): Promise<SkillDefinition | undefined>
}

/** Resolve the host skill registry, or undefined when this profile lacks one. */
export function skillRegistry(ctx: Context): SkillRegistryFace | undefined {
  try {
    return ctx.get('skills') as SkillRegistryFace | undefined
  } catch {
    // service not injected/mounted in this context
    return undefined
  }
}

/** Whether the provided skill name is a syntactically valid skill name. */
export function validSkillName(name: string): boolean {
  return isSkillName(name)
}

/**
 * Build the instructions-form message carrying the rendered skill body, the
 * same shape a user `/grill-me` invocation injects through `tool-skill`. The
 * `skill-invocation` source is what the transcript UI decorates as a skill
 * chip; the content is the canonical `<skill_content>` block.
 */
export function skillInvocationMessage(skill: Pick<SkillDefinition, 'name' | 'provider' | 'resourceBase' | 'content'>) {
  return createUserMessage({
    content: [{ type: 'text', text: renderSkillContent(skill) }],
    source: { kind: 'skill-invocation', name: skill.name, form: 'instructions' },
  })
}

/**
 * Load the skill body the card names, scoped to the refinement agent so
 * preset-layer providers (the filesystem skill roots) are visible. Returns
 * undefined when the skill is unknown, not user-invocable, or the registry is
 * absent — the caller decides how to surface that.
 */
export async function loadCardSkill(
  ctx: Context,
  name: string | undefined,
  cwd: string,
  scope: unknown,
): Promise<Pick<SkillDefinition, 'name' | 'provider' | 'resourceBase' | 'content'> | undefined> {
  if (name === undefined || !isSkillName(name)) return undefined
  const registry = skillRegistry(ctx)
  if (registry === undefined) return undefined
  const skill = await registry.get(name, { cwd, scope })
  if (skill === undefined || !isUserInvocable(skill)) return undefined
  return skill
}