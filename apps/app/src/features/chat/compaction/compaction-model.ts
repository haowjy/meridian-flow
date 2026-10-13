/**
 * Presentation reads of compaction dividers. The metadata readers live in
 * `@meridian/contracts/threads`.
 */
import { t } from "@lingui/core/macro";
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
  /** Writer copy for a failure the writer must hear about; null keeps R3's quiet divider. */
  failureCopy: string | null;
};

/** A failed compaction in the writer's words: the server's generic copy owns it. */
export function compactionFailureCopy(turn: Turn): string {
  return turn.error ?? t`This conversation couldn't be compacted.`;
}

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
  // R3: an autocompaction's failure is carried by the failed reply under the
  // writer's newest message. A manual one has no reply to carry it.
  const failureCopy =
    state === "failed" && facts.trigger === "manual" ? compactionFailureCopy(turn) : null;
  return {
    state,
    trigger: facts.trigger,
    instructions: facts.instructions,
    summary: facts.summary,
    model: facts.model,
    tokens,
    failureCopy,
  };
}
