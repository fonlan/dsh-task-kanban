/**
 * User-facing plugin settings (global parallel worker count, default model),
 * persisted through the settings service namespace `task-kanban`. The DSH
 * settings service requires a lowercase kebab-case namespace
 * (/^[a-z][a-z0-9-]*$/), so the scoped package name cannot be used here.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { KanbanSettingsShape } from '../shared/card.js';
export declare const KANBAN_SETTINGS_NS: import("@deepseek-ai/dsh-settings").SettingsNamespace;
export declare const KanbanSettingsSchema: z<Schemastery.ObjectS<{
    maxParallelWorkers: z<number, number>;
    defaultModel: z<string, string>;
}>, Schemastery.ObjectT<{
    maxParallelWorkers: z<number, number>;
    defaultModel: z<string, string>;
}>>;
export interface KanbanSettingsFace {
    get(): KanbanSettingsShape;
    update(patch: Partial<KanbanSettingsShape>): Promise<void>;
    /** Default provider/model route from the agent-default-model settings namespace. */
    defaultModelRoute(): {
        provider?: string;
        model?: string;
    };
}
export declare function registerSettings(ctx: Context): KanbanSettingsFace;
