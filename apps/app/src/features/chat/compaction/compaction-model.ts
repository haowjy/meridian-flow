/**
 * Pure reads of compaction dividers.
 *
 * A compaction turn is a transcript row that shows where the model's context
 * was summarized. Metadata is read defensively: the server's codecs own the
 * shape, the client only picks the fields the writer sees.
 */
import type { Turn } from "@meridian/contracts/protocol";

export type CompactionTrigger = "auto" | "manual";

export type CompactionFacts = {
  trigger: CompactionTrigger;
  /** The writer command this divider ran (`controlMessageId`); null for an automatic one. */
  controlId: string | null;
  /** Typed failure reason on an errored divider; null otherwise. */
  failureReason: string | null;
  summary: string | null;
  tokensBefore: number | null;
  tokensAfter: number | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function isCompactionTurn(turn: Turn): boolean {
  return turn.role === "compaction";
}

export function readCompactionFacts(turn: Turn): CompactionFacts {
  const metadata = record(turn.metadata);
  const controlMessageId = text(metadata?.controlMessageId);
  const trigger: CompactionTrigger =
    metadata?.trigger === "manual" || (metadata?.trigger === undefined && controlMessageId)
      ? "manual"
      : "auto";
  const summaryBlock = (turn.blocks ?? []).find(
    (block) => block.blockType === "custom" && record(block.content)?.kind === "compaction",
  );
  const props = record(record(summaryBlock?.content)?.props);
  return {
    trigger,
    controlId: controlMessageId,
    failureReason: turn.status === "error" ? text(metadata?.reason) : null,
    summary: text(props?.summary),
    tokensBefore: count(props?.tokensBefore),
    tokensAfter: count(props?.tokensAfter),
  };
}

/** Every writer command a divider already answers: a queued item for one is no longer queued. */
export function answeredControlIds(turns: readonly Turn[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    const id = turn.role === "compaction" ? readCompactionFacts(turn).controlId : null;
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * R4: a context-window overflow completes the running assistant turn empty
 * before the compaction that recovers it. It says nothing to the writer.
 */
export function isOverflowShell(turn: Turn, next: Turn | undefined): boolean {
  return (
    next?.role === "compaction" &&
    turn.role === "assistant" &&
    turn.status === "complete" &&
    (turn.blocks ?? []).length === 0
  );
}

export type DividerState = "pending" | "complete" | "failed" | "cancelled";

export type DividerView = {
  state: DividerState;
  trigger: CompactionTrigger;
  /**
   * A `/compact` that found too little new history since the last compaction.
   * Expected after an automatic compaction absorbed the need: it reads calmly,
   * never as an error.
   */
  nothingToCompact: boolean;
  summary: string | null;
  /** Shown only when the compaction actually made the context smaller. */
  tokens: { before: number; after: number } | null;
  /** Writer copy for a failure the writer must hear about; null keeps R3's quiet divider. */
  failureCopy: string | null;
};

/**
 * One divider's view state. `failureCopyFor` supplies client-owned copy for
 * reasons whose server copy would mislead (`compactionFailureCopy` in
 * `CompactionDivider.tsx`).
 */
export function dividerView(input: {
  turn: Turn;
  failureCopyFor: (reason: string | null, serverCopy: string | null) => string | null;
}): DividerView {
  const { turn } = input;
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
    facts.tokensBefore !== null &&
    facts.tokensAfter !== null &&
    facts.tokensAfter < facts.tokensBefore
      ? { before: facts.tokensBefore, after: facts.tokensAfter }
      : null;
  const nothingToCompact = state === "failed" && facts.failureReason === "nothing_to_compact";
  // R3: an autocompaction's failure is carried by the failed reply under the
  // writer's newest message. A manual one has no reply to carry it.
  const failureCopy =
    state === "failed" && facts.trigger === "manual" && !nothingToCompact
      ? input.failureCopyFor(facts.failureReason, turn.error)
      : null;
  return {
    state,
    trigger: facts.trigger,
    nothingToCompact,
    summary: facts.summary,
    tokens,
    failureCopy,
  };
}
