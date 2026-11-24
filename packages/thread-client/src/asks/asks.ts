import type {
  AskAnswer,
  AskResolution,
  AskStatus,
  ThreadAsk,
  Turn,
  TurnStatus,
} from "@meridian/contracts/threads";

export type AskAnswerAttempt = {
  askId: string;
  submissionId: string;
  answer: AskAnswer;
  state: "sending" | "failed" | "settling" | "unsettled";
};

export type ChatAsks = {
  byId: ReadonlyMap<string, ThreadAsk>;
  byTurn: ReadonlyMap<string, string>;
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

export function failAskAnswer(asks: ChatAsks, askId: string, submissionId: string): ChatAsks {
  const held = asks.attempts.get(askId);
  if (held?.submissionId !== submissionId || held.state === "failed") return asks;
  const attempts = new Map(asks.attempts);
  attempts.set(askId, { ...held, state: "failed" });
  return { ...asks, attempts };
}

export function clearAskAnswer(asks: ChatAsks, askId: string, submissionId: string): ChatAsks {
  if (asks.attempts.get(askId)?.submissionId !== submissionId) return asks;
  const attempts = new Map(asks.attempts);
  attempts.delete(askId);
  return { ...asks, attempts };
}

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

function nearestAssistantTurnId(turns: readonly Turn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role === "assistant") return turns[index].id;
  }
  return null;
}

export type OpenAsk = {
  ask: ThreadAsk;
  attempt: AskAnswerAttempt | null;
};

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
  resolution: AskResolution;
  pending: boolean;
};

export function askReceipt(asks: ChatAsks, turnId: string): AskReceipt | null {
  const ask = askOfTurn(asks, turnId);
  if (!ask) return null;
  if (ask.resolution) return { ask, resolution: ask.resolution, pending: false };
  const attempt = asks.attempts.get(ask.id);
  return attempt?.state === "sending" ? { ask, resolution: attempt.answer, pending: true } : null;
}
