import type { KanbanCard } from '../shared/card.js';
/** Refinement session prompt: analyze the repo read-only and write back a plan. */
export declare function refinementPrompt(requirement: string, workspacePath: string): string;
/**
 * Interactive refinement prompt for a card created with a skill (e.g.
 * `/grill-me`). The refinement session is explicit — the user can reply —
 * so instead of deciding autonomously, the agent follows the skill's
 * interview and asks whatever it needs before writing the plan back.
 */
export declare function interactiveRefinementPrompt(requirement: string, workspacePath: string): string;
/** Phase implementation session prompt; identical on retries (the model reads git status/diff itself). */
export declare function phasePrompt(card: KanbanCard, phaseIndex: number, workdir: string): string;
/** Merge-conflict resolution session prompt: resolve conflicts only, never commit. */
export declare function mergePrompt(workdir: string, conflicts: string): string;
