import type { Context } from '@deepseek-ai/cordis';
import type { KanbanCard, Lane, Plan } from '../shared/card.js';
import type { TaskStore } from './task-store.js';
import type { KanbanSettingsFace } from './settings.js';
import { type KanbanToolResolver } from './tools.js';
export declare class KanbanRunner implements KanbanToolResolver {
    private ctx;
    private store;
    private settings;
    private runningByWs;
    private slots;
    private pumpTimer;
    /** sessionId → cardId (sessions created for this kanban). */
    private sessionCards;
    /** sessionId → true once the scoped completion tool ran. */
    private completed;
    private merging;
    /** Retained agent handles (kept so ended sessions stay in the store/UI). */
    private handles;
    /** Whether startup recovery + session indexing ran (deferred until workspaces exist). */
    private recovered;
    /** Agents that already got their scoped kanban tools (event idempotency). */
    private toolScopedAgents;
    private agentStartOff;
    constructor(ctx: Context, store: TaskStore, settings: KanbanSettingsFace);
    register(ctx: Context): void;
    start(): void;
    stop(): void;
    private newSessionId;
    private asUserMessage;
    private workspaceList;
    cardOfSession(sessionId?: string): string | undefined;
    writePlan(cardId: string, plan: Plan): Promise<void>;
    phaseComplete(sessionId: string, summary: string): Promise<string>;
    mergeResolved(sessionId: string): Promise<void>;
    private toolResolver;
    recoverInterrupted(): Promise<void>;
    /**
     * Rebuild sessionId → cardId from the task store. Runs once the workspace
     * registry is available (see pump), so kanban sessions resumed after a
     * restart still resolve their card.
     */
    private indexSessions;
    private mapCardSessions;
    /** Fallback lookup when a session starts before indexSessions ran. */
    private lookupCardOfSession;
    /**
     * The single place kanban tools get registered. `agent/session-start` fires
     * for BOTH `agents.create` (startup) and `agents.resume` (host re-open after
     * a restart), so a resumed refinement/phase/merge session keeps its scoped
     * tools. Idempotent per agent object; non-kanban sessions are skipped.
     */
    private onAgentSessionStart;
    listCards(workspacePath: string): Promise<KanbanCard[]>;
    createTask(input: {
        workspacePath: string;
        requirement: string;
        model: string;
        provider?: string;
        skill?: string;
    }): Promise<KanbanCard>;
    moveTask(cardId: string, toLane: Lane): Promise<{
        ok: boolean;
        message?: string;
    }>;
    stopTask(cardId: string): Promise<{
        ok: boolean;
        message?: string;
    }>;
    retryTask(cardId: string): Promise<{
        ok: boolean;
        message?: string;
    }>;
    deleteTask(cardId: string): Promise<{
        ok: boolean;
        message?: string;
    }>;
    private findCard;
    private maxParallel;
    pump(): Promise<void>;
    private requestStop;
    private fail;
    private runRefinement;
    /**
     * Drive the refinement session to a terminal card state. Non-interactive
     * cards follow the original contract: the agent finishes one turn and must
     * have written the plan. Interactive cards (created with a refinement
     * skill) may ask the user clarifying questions — the session is explicit
     * and visible in the workspace chat, so the runner waits for each reply
     * instead of failing, and only settles when the plan is written or the
     * session errors out.
     */
    private driveRefinement;
    /**
     * A promise resolving when the card stops being 'refining' (planned,
     * failed, or gone), plus a disposer stopping the polling interval.
     */
    private waitForCardSettlement;
    /**
     * A promise resolving when a NEW human message enters the given session,
     * plus a disposer detaching the listener. Messages injected by plugins with
     * non-`user` sources (such as our skill-invocation instructions) never
     * resolve it — only real human replies drive the interactive refinement.
     */
    private waitForUserReply;
    private createAgent;
    private keepHandle;
    /**
     * Account the refinement session to its host workspace so it shows in that
     * workspace's session list. The session's cwd IS the workspace root, so the
     * registry's strict `cwd === workspace.path` check passes. Best-effort only:
     * an unregistered workspace (or a failing registry) must not break the card.
     */
    private attachRefinementSession;
    /** The host workspace registry, whichever service name carries it. */
    private attachRegistry;
    /** Resolve the provider+model route for an agent (both are required). */
    private modelRoute;
    private runCard;
    private runPhase;
    private resolveConflictsIn;
    /** Check resolved files for leftover conflict markers. */
    private verifyConflictMarkers;
    runMerge(cardId: string, wsPath: string): Promise<boolean>;
    private mergeCard;
    private runMergeSession;
    private ensureGitignoreDsh;
}
