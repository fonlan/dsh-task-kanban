/**
 * @fonlan/dsh-task-kanban host half: the task kanban engine.
 *
 * Mounts a file-backed task store under each workspace's
 * `.dsh/task-kanban/`, runs refinement/phase/merge sessions through
 * `ctx.agents` (standard coding-agent preset + kanban-scoped tools), and
 * serves the fenced JSON API the board UI calls.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "@fonlan/dsh-task-kanban";
export declare const inject: string[];
export declare const Config: z<Schemastery.ObjectS<{}>, Schemastery.ObjectT<{}>>;
export declare function apply(ctx: Context, _config: unknown): void;
