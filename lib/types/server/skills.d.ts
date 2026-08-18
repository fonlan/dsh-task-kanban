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
import type { Context } from '@deepseek-ai/cordis';
import { type SkillDefinition, type SkillSummary } from '@deepseek-ai/dsh-skill';
/** A parsed leading skill gesture: the skill name plus the cleaned requirement. */
export interface SkillGestureParse {
    /** The skill name from the leading `/name` token, if the input led with one. */
    skill?: string;
    /** The requirement text with the leading gesture removed. */
    requirement: string;
}
/**
 * Extract a leading `/skill-name` gesture from raw create-task input. Only a
 * token at the very start selects a skill; tokens later in the text are
 * ordinary requirement prose (the user might legitimately mention paths or
 * fractions). The name is grammar-validated but not registry-checked here —
 * unknown names surface as a refinement error with a clear message.
 */
export declare function parseSkillGesture(raw: string): SkillGestureParse;
/**
 * The minimal view of the hosted skill registry the plugin needs: list for a
 * summary lookup and get for a full body, both honoring the calling scope.
 */
export interface SkillRegistryFace {
    list(options?: {
        cwd?: string;
        scope?: unknown;
    }): Promise<SkillSummary[]>;
    get(name: string, options?: {
        cwd?: string;
        scope?: unknown;
    }): Promise<SkillDefinition | undefined>;
}
/** Resolve the host skill registry, or undefined when this profile lacks one. */
export declare function skillRegistry(ctx: Context): SkillRegistryFace | undefined;
/** Whether the provided skill name is a syntactically valid skill name. */
export declare function validSkillName(name: string): boolean;
/**
 * Build the instructions-form message carrying the rendered skill body, the
 * same shape a user `/grill-me` invocation injects through `tool-skill`. The
 * `skill-invocation` source is what the transcript UI decorates as a skill
 * chip; the content is the canonical `<skill_content>` block.
 */
export declare function skillInvocationMessage(skill: Pick<SkillDefinition, 'name' | 'provider' | 'resourceBase' | 'content'>): {
    content: {
        type: "text";
        text: string;
    }[];
    source: {
        kind: "skill-invocation";
        name: string;
        form: "instructions";
    };
} & Pick<import("@deepseek-ai/dsh-llm").UserMessage, "id" | "role">;
/**
 * Load the skill body the card names, scoped to the refinement agent so
 * preset-layer providers (the filesystem skill roots) are visible. Returns
 * undefined when the skill is unknown, not user-invocable, or the registry is
 * absent — the caller decides how to surface that.
 */
export declare function loadCardSkill(ctx: Context, name: string | undefined, cwd: string, scope: unknown): Promise<Pick<SkillDefinition, 'name' | 'provider' | 'resourceBase' | 'content'> | undefined>;
