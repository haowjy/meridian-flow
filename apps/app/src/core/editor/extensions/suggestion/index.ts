/**
 * The editor's adapter for a menu the writer types underneath.
 *
 * One mechanism ([`suggestion-lane.ts`](suggestion-lane.ts)) wires
 * `@tiptap/suggestion`, the chrome kernel, and the headless store in
 * [`@/core/completion`](../../../completion/index.ts) to whatever a lane
 * declares. Plus the one piece of the trigger envelope every lane agrees on:
 * which blocks count as prose. Where a lane may open, what it offers, and what
 * a choice writes are each lane's own answer.
 */

export { PROSE_TRIGGER_BLOCKS } from "./prose-trigger-blocks";
export {
  createSuggestionLane,
  type SuggestionLane,
  type SuggestionLaneOptions,
  type SuggestionLaneSpec,
} from "./suggestion-lane";
