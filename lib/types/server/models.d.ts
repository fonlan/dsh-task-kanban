import type { Context } from '@deepseek-ai/cordis';
import type { ModelOption } from '../shared/card.js';
/** Available models from every registered LLM provider (advisory catalog). */
export declare function listModels(ctx: Context): Promise<ModelOption[]>;
