/**
 * Plan payload validation (shared by the write-back tool and tests).
 */
import type { Plan } from './card.js';
export type ValidatePlanResult = {
    ok: true;
    plan: Plan;
} | {
    ok: false;
    message: string;
};
export declare function validatePlan(input: unknown): ValidatePlanResult;
