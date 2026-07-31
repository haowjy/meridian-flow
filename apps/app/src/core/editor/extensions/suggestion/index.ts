/**
 * The editor's adapter for a menu the writer types underneath.
 *
 * One mechanism ([`suggestion-lane.ts`](suggestion-lane.ts)) wires
 * `@tiptap/suggestion`, the chrome kernel, and the headless store in
 * [`@/core/completion`](../../../completion/index.ts) to whatever a lane
 * declares. Beside it, the parts of the trigger envelope every lane agrees on
 * ([`trigger-envelope.ts`](trigger-envelope.ts)): what prose is, what a word
 * boundary is, and where a reference may be spelled. What a lane demands on top
 * of those, what it offers, and what a choice writes are each lane's own answer.
 */

export {
  createSuggestionLane,
  type SuggestionLane,
  type SuggestionLaneOptions,
  type SuggestionLaneSpec,
} from "./suggestion-lane";
export { allowsProseTrigger, atWordBoundary, inProseBlock } from "./trigger-envelope";
