import type { Context } from '@deepseek-ai/cordis';
import type { Plan } from '../shared/card.js';
export interface KanbanToolResolver {
    /** Resolve the card id attached to a calling session id. */
    cardOfSession(sessionId?: string): string | undefined;
    writePlan(cardId: string, plan: Plan): Promise<void>;
    /** Mark the phase done; returns the phase id for the tool output. */
    phaseComplete(sessionId: string, summary: string): Promise<string>;
    mergeResolved(sessionId: string): Promise<void>;
}
export declare function registerKanbanTools(agentCtx: Context, resolver: KanbanToolResolver): void;
