/**
 * The pure decisions behind Stop and hand-back: which waiting writer messages leave the chat, and
 * whether the open execution is cancelled. The adapter reads the facts under the thread lock, calls
 * these before any write, and then applies the decision. Nothing here reads a clock or a hint.
 */
import { createHash } from "node:crypto";

/** One writer message, as the press sees it. `delivered` and `byExecution` come from rows, never hints. */
export type WriterRow = {
  /** The inbox row id, which is also the message's user turn id. */
  id: string;
  seq: number;
  /** The row is acknowledged (answered, or handed back). */
  delivered: boolean;
  /** A turn of the open execution delivered it. */
  byExecution: boolean;
  /** The hand-back request that took it out of the chat, or null. */
  handedBackBy: string | null;
};

export type StopFacts = {
  /**
   * The open execution: the lease row, expiry ignored, when some turn carries its id. Null otherwise.
   * `holder` is the role of the turn bound to the lease.
   */
  execution: { id: string; holder: "assistant" | "compaction" | null } | null;
  /** The lease's adopted message ids. Empty with no lease row. */
  receipt: readonly string[];
  /** The chat's relevant writer messages: see `readFacts`. */
  rows: readonly WriterRow[];
  /** The open execution admitted the continuation of a question the writer answered. */
  continuesWriterAnswer: boolean;
};

export type HandBackScopeFacts =
  | { kind: "ids"; ids: readonly string[] }
  | { kind: "seen"; seenThrough: number; mine: readonly string[] };

export type StopPress = {
  seenThrough: number;
  seenExecutionId: string | null;
  mine: readonly string[];
};

/** What one request does with every message its scope names. */
export type HandBackDecision = {
  /** Leave the chat now, in send order. */
  handBack: string[];
  /** Taken on by an execution that goes on. */
  answered: string[];
  /** Already handed back by another request. */
  gone: string[];
};

export type StopDecision = HandBackDecision & {
  /** The execution to cancel, or null. */
  cancelExecutionId: string | null;
};

function covered(rows: readonly WriterRow[], scope: HandBackScopeFacts): WriterRow[] {
  const picked =
    scope.kind === "ids"
      ? new Set(scope.ids)
      : new Set([
          ...rows.filter((row) => row.seq <= scope.seenThrough).map((row) => row.id),
          ...scope.mine,
        ]);
  // Ids that are not among the chat's writer messages are ignored.
  return rows.filter((row) => picked.has(row.id)).sort((left, right) => left.seq - right.seq);
}

/** Whether the open execution has taken the message on: it is in the receipt, or one of its turns delivered it. */
function takesOn(facts: StopFacts, row: WriterRow): boolean {
  return facts.receipt.includes(row.id) || row.byExecution;
}

/**
 * Classifies every covered message. `cancels` is whether this same request cancels the open
 * execution (Stop's rule); the queue's x and Cancel queue pass false.
 */
export function decideHandBack(
  facts: StopFacts,
  scope: HandBackScopeFacts,
  cancels: boolean,
): HandBackDecision {
  const decision: HandBackDecision = { handBack: [], answered: [], gone: [] };
  for (const row of covered(facts.rows, scope)) {
    const inReceipt = facts.receipt.includes(row.id);
    if (row.handedBackBy !== null) decision.gone.push(row.id);
    else if (!row.delivered && !inReceipt) decision.handBack.push(row.id);
    else if (!row.delivered && inReceipt && cancels && facts.execution?.holder === "compaction")
      decision.handBack.push(row.id);
    else decision.answered.push(row.id);
  }
  return decision;
}

/**
 * Stop: P is the rows at or below `seenThrough` plus `mine`; L is the writer messages above the
 * watermark that are not `mine`. The execution is cancelled when the writer saw it, it took on a
 * message in P, or it continues the writer's answer to a question (an answer is the writer's own
 * request, like `mine`), unless it has taken on a message in L (cancelling would answer that
 * message with a cancelled reply). A message in L that the execution has not taken on is not
 * protected: the cancel flag refuses any further adoption, so it waits for the next execution.
 */
export function decideStop(facts: StopFacts, press: StopPress): StopDecision {
  const scope: HandBackScopeFacts = {
    kind: "seen",
    seenThrough: press.seenThrough,
    mine: press.mine,
  };
  const inP = new Set(covered(facts.rows, scope).map((row) => row.id));
  const execution = facts.execution;
  const pressRows = facts.rows.filter((row) => inP.has(row.id));
  const laterRows = facts.rows.filter((row) => !inP.has(row.id));
  const cancels =
    execution !== null &&
    (execution.id === press.seenExecutionId ||
      facts.continuesWriterAnswer ||
      pressRows.some((row) => takesOn(facts, row))) &&
    !laterRows.some((row) => takesOn(facts, row));
  return {
    ...decideHandBack(facts, scope, cancels),
    cancelExecutionId: cancels ? execution.id : null,
  };
}

export type SendNowPress = {
  seenThrough: number;
  seenExecutionId: string;
  /** Every writer message the record showed waiting, frozen at the press. */
  waiting: readonly string[];
};

/**
 * Send now: with W the `waiting` rows and L the rows above `seenThrough` that are not in W, cancel the
 * open execution iff it is the one seen and has taken on no row in W (it would answer the queue with a
 * cancelled reply: too late) and none in L. Both sets come from the frozen press, never a newer record.
 * Hands nothing back: the queue runs in the next reply.
 */
export function decideSendNow(
  facts: StopFacts,
  press: SendNowPress,
): { cancelExecutionId: string | null } {
  const waiting = new Set(press.waiting);
  const execution = facts.execution;
  const cancels =
    execution !== null &&
    execution.id === press.seenExecutionId &&
    !facts.rows.some(
      (row) => (waiting.has(row.id) || row.seq > press.seenThrough) && takesOn(facts, row),
    );
  return { cancelExecutionId: cancels ? execution.id : null };
}

/** Canonical body hash: the same request id with another body is a different request. */
export function handBackFingerprint(body: {
  kind: "hand_back" | "stop";
  scope: HandBackScopeFacts;
  seenExecutionId?: string | null;
}): string {
  const scope =
    body.scope.kind === "ids"
      ? { kind: "ids", ids: [...body.scope.ids].sort() }
      : {
          kind: "seen",
          seenThrough: body.scope.seenThrough,
          mine: [...body.scope.mine].sort(),
        };
  return createHash("sha256")
    .update(
      JSON.stringify({ kind: body.kind, scope, seenExecutionId: body.seenExecutionId ?? null }),
    )
    .digest("hex");
}
