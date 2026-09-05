/**
 * The editor's adapter for a menu the writer types underneath.
 *
 * One mechanism ([`suggestion-lane.ts`](suggestion-lane.ts)) wires
 * `@tiptap/suggestion`, an injected semantic suggestion host, and the headless lifecycle
 * in [`@/core/completion`](../../../completion/index.ts) to whatever a lane
 * declares. Plus the one piece of the trigger envelope every lane agrees on:
 * which blocks count as prose. Where a lane may open, what it offers, and what
 * a choice writes are each lane's own answer.
 */

export { PROSE_TRIGGER_BLOCKS } from "./prose-trigger-blocks";
export {
  createSuggestionLane,
  defaultSuggestionLaneDriver,
  type SuggestionLane,
  type SuggestionLaneDriverFactory,
  type SuggestionLaneDriverRuntime,
  type SuggestionLaneOptions,
  type SuggestionLaneSpec,
} from "./suggestion-lane";
