import type { Context } from '@deepseek-ai/cordis';
import type { KanbanRunner } from './runner.js';
import type { KanbanSettingsFace } from './settings.js';
export declare function registerApiRoutes(ctx: Context, runner: KanbanRunner, settings: KanbanSettingsFace): () => void;
