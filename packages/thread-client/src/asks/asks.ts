/**
 * A chat's asks and this device's answers to them, as plain values on `SyncedThread`, with the
 * pure transitions and the two projections the screen draws: the open ask that takes over the
 * composer, and the one-line receipt on an asking turn.
 *
 * The server's `ThreadAsk` is the authority. Its status only moves forward (pending, open, then
 * one resolution), so a read or reply that carries an older status than the one held never moves
 * it back, whatever order frames, reads and replies arrive in.
 */
import type {
  AskAnswer,
  AskResolution,
  AskStatus,
  ThreadAsk,
  Turn,
  TurnStatus,
} from "@meridian/contracts/threads";

/** This device's answer to an open ask, until the server's resolution replaces it. */
export type AskAnswerAttempt = {
  askId: string;
  submissionId: string;
  answer: AskAnswer;
  /**
   * - `sending`: on the wire; the receipt shows it, marked pending.
   * - `failed`: did not land; the takeover reopens with it and Retry.
   * - `settling`: the server said the ask is no longer open without saying how it ended; nothing
   *   can answer it until a read does.
   * - `unsettled`: that read failed; the takeover offers only to read again.
   */
  state: "sending" | "failed" | "settling" | "unsettled";
};

export type ChatAsks = {
  byId: ReadonlyMap<string, ThreadAsk>;
  /** Each asking turn's newest ask id, so a turn's receipt is one lookup. */
  byTurn: ReadonlyMap<string, string>;
  /** Keyed by ask id: one answer per ask at a time. */
  attempts: ReadonlyMap<string, AskAnswerAttempt>;
};

export const EMPTY_CHAT_ASKS: ChatAsks = {
  byId: new Map(),
  byTurn: new Map(),
  attempts: new Map(),
};

const STATUS_RANK: Record<AskStatus, number> = {
  pending: 0,
  open: 1,
  answered: 2,
  expired: 2,
  cancelled: 2,
};

const isResolved = (ask: ThreadAsk) => STATUS_RANK[ask.status] === 2;

/** Take server asks (a read's, a frame's or a reply's). Resolved asks retire this device's attempt. */
export function receiveAsks(asks: ChatAsks, incoming: readonly ThreadAsk[]): ChatAsks {
  let byId: Map<string, ThreadAsk> | null = null;
  let byTurn: Map<string, string> | null = null;
  let attempts: Map<string, AskAnswerAttempt> | null = null;
  for (const ask of incoming) {
    const held = (byId ?? asks.byId).get(ask.id);
    if (held && STATUS_RANK[held.status] > STATUS_RANK[ask.status]) continue;
    if (held && isResolved(held)) continue;
    byId ??= new Map(asks.byId);
    byId.set(ask.id, ask);
    const newest = (byTurn ?? asks.byTurn).get(ask.turnId);
    const newestAsk = newest === undefined ? undefined : byId.get(newest);
    if (!newestAsk || newestAsk.id === ask.id || ask.createdAt > newestAsk.createdAt) {
      byTurn ??= new Map(asks.byTurn);
      byTurn.set(ask.turnId, ask.id);
    }
    if (isResolved(ask) && (attempts ?? asks.attempts).has(ask.id)) {
      attempts ??= new Map(asks.attempts);
      attempts.delete(ask.id);
    }
  }
  if (!byId) return asks;
  return { byId, byTurn: byTurn ?? asks.byTurn, attempts: attempts ?? asks.attempts };
}

/**
 * Start answering: the attempt goes on the wire. A Retry of the failed answer keeps its
 * submission id, so a frame that did land answers once; a different answer is a new submission.
 */
export function beginAskAnswer(
  asks: ChatAsks,
  askId: string,
  answer: AskAnswer,
  newSubmissionId: () => string,
): { asks: ChatAsks; attempt: AskAnswerAttempt } {
  const held = asks.attempts.get(askId);
  const submissionId =
    held && sameAnswer(held.answer, answer) ? held.submissionId : newSubmissionId();
  const attempt: AskAnswerAttempt = { askId, submissionId, answer, state: "sending" };
  const attempts = new Map(asks.attempts);
  attempts.set(askId, attempt);
  return { asks: { ...asks, attempts }, attempt };
}

/** The attempt did not land; only the attempt that failed changes. */
export function failAskAnswer(asks: ChatAsks, askId: string, submissionId: string): ChatAsks {
  const held = asks.attempts.get(askId);
  if (held?.submissionId !== submissionId || held.state === "failed") return asks;
  const attempts = new Map(asks.attempts);
  attempts.set(askId, { ...held, state: "failed" });
  return { ...asks, attempts };
}

/** The server refused the answer outright: drop that attempt, so nothing offers to resend it. */
export function clearAskAnswer(asks: ChatAsks, askId: string, submissionId: string): ChatAsks {
  if (asks.attempts.get(askId)?.submissionId !== submissionId) return asks;
  const attempts = new Map(asks.attempts);
  attempts.delete(askId);
  return { ...asks, attempts };
}

/** Move the ask's attempt to `state`; an ask with no attempt is left alone. */
export function markAskAnswer(
  asks: ChatAsks,
  askId: string,
  state: "settling" | "unsettled",
): ChatAsks {
  const held = asks.attempts.get(askId);
  if (!held || held.state === state) return asks;
  const attempts = new Map(asks.attempts);
  attempts.set(askId, { ...held, state });
  return { ...asks, attempts };
}

/**
 * The asking turn's terminal status after its ask resolves, and which held status it replaces.
 * The asking run's finish alone writes `awaiting_answer`; ask frames own only the later transition.
 */
export function askingTurnStatus(
  ask: ThreadAsk,
): { status: TurnStatus; from: readonly TurnStatus[] } | null {
  switch (ask.status) {
    case "pending":
    case "open":
      return null;
    case "answered":
    case "expired":
      return { status: "complete", from: ["awaiting_answer"] };
    case "cancelled":
      return { status: "cancelled", from: ["awaiting_answer"] };
  }
}

function sameAnswer(a: AskAnswer, b: AskAnswer): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The latest assistant turn the chat holds: the only turn whose ask can be open. */
function nearestAssistantTurnId(turns: readonly Turn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role === "assistant") return turns[index].id;
  }
  return null;
}

export type OpenAsk = {
  ask: ThreadAsk;
  /** A `failed` answer (filled back in, with Retry) or an `unsettled` one (read again). */
  attempt: AskAnswerAttempt | null;
};

/**
 * The ask that takes over the composer: open, on the chat's nearest assistant turn, and not being
 * answered or settled from this device right now (a sending answer shows as the pending receipt;
 * a settling one waits for the read that says how the ask ended).
 */
export function openAsk(asks: ChatAsks, turns: readonly Turn[]): OpenAsk | null {
  const turnId = nearestAssistantTurnId(turns);
  const ask = turnId === null ? undefined : askOfTurn(asks, turnId);
  if (ask?.status !== "open") return null;
  const attempt = asks.attempts.get(ask.id) ?? null;
  if (attempt?.state === "sending" || attempt?.state === "settling") return null;
  return { ask, attempt };
}

function askOfTurn(asks: ChatAsks, turnId: string): ThreadAsk | undefined {
  const askId = asks.byTurn.get(turnId);
  return askId === undefined ? undefined : asks.byId.get(askId);
}

export type AskReceipt = {
  ask: ThreadAsk;
  /** How it ended, or this device's sending answer before the server confirms it. */
  resolution: AskResolution;
  pending: boolean;
};

/** The receipt line for an asking turn, or null while its ask is unresolved and unanswered here. */
export function askReceipt(asks: ChatAsks, turnId: string): AskReceipt | null {
  const ask = askOfTurn(asks, turnId);
  if (!ask) return null;
  if (ask.resolution) return { ask, resolution: ask.resolution, pending: false };
  const attempt = asks.attempts.get(ask.id);
  return attempt?.state === "sending" ? { ask, resolution: attempt.answer, pending: true } : null;
}
