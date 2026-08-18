import { type KanbanCard } from '../shared/card.js';
/**
 * File-backed task store: one JSON file per card under
 * `<workspace>/.dsh/task-kanban/tasks/<id>.json`. In-process cache plus
 * atomic (tmp+rename) writes, with a per-card mutex so worker and RPC
 * mutations never interleave.
 */
export declare class TaskStore {
    private cache;
    private locks;
    private taskDir;
    private fileOf;
    private withLock;
    list(workspacePath: string): Promise<KanbanCard[]>;
    get(workspacePath: string, id: string): Promise<KanbanCard | undefined>;
    create(input: {
        workspacePath: string;
        requirement: string;
        model: string;
        provider?: string;
        skill?: string;
        status?: KanbanCard['status'];
    }): Promise<KanbanCard>;
    /** Run a mutation under the card's lock; returns the updated card. */
    mutate(id: string, fn: (card: KanbanCard) => void | Promise<void>, workspacePath?: string): Promise<KanbanCard | undefined>;
    private write;
    remove(workspacePath: string, id: string): Promise<void>;
}
