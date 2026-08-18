/**
 * Lane mapping and drag rules (shared by the board UI and tests).
 */
import type { KanbanCard, Lane } from './card.js';
/** Which lane a card renders in, based on status + error stage. */
export declare function laneOf(card: KanbanCard): Lane;
/** Lanes a drop onto `to` may come from. */
export declare const DROP_RULES: Record<Lane, Lane[]>;
export declare function canDrop(from: Lane, to: Lane): boolean;
