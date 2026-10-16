/**
 * Presentation reads of compaction dividers. The metadata readers live in
 * `@meridian/contracts/threads`.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { type CompactionTrigger, readCompactionFacts } from "@meridian/contracts/threads";

export type DividerState = "pending" | "complete" | "failed" | "cancelled";

export type DividerView = {
  state: DividerState;
  trigger: CompactionTrigger;
  /** What the writer asked the summary to do (`/compact <instructions>`). */
  instructions: string | null;
  summary: string | null;
  /** Stats for nerds: the summary's model and the context size either side. */
  model: string | null;
  tokens: { before: number; after: number } | null;
};

/** One divider's view state. */
export function dividerView(turn: Turn): DividerView {
  const facts = readCompactionFacts(turn);
  const state: DividerState =
    turn.status === "pending" || turn.status === "streaming"
      ? "pending"
      : turn.status === "error"
        ? "failed"
        : turn.status === "cancelled"
          ? "cancelled"
          : "complete";
  const tokens =
    facts.tokensBefore !== null && facts.tokensAfter !== null
      ? { before: facts.tokensBefore, after: facts.tokensAfter }
      : null;
  return {
    state,
    trigger: facts.trigger,
    instructions: facts.instructions,
    summary: facts.summary,
    model: facts.model,
    tokens,
  };
}
