import type { ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { isTerminalTurnStatus, retryTargetOf, type Turn } from "@meridian/contracts/threads";
import { isBlockedForUsage, isOwed } from "./fold-messages";
import { addIntent, INITIAL_RUN_STATE_VIEW, receiveRecord } from "./run-state-view";

export type MessageFate =
  | { kind: "waiting"; blocked: boolean }
  | { kind: "handedBack" }
  | { kind: "forgotten"; forgottenBy: string }
  | { kind: "answering"; answeredBy: string; chain: string[]; last: Turn }
  | { kind: "answered"; answeredBy: string; chain: string[]; last: Turn }
  | { kind: "unproven"; reason: "deliverer_unknown" | "unconfirmed" };

export function messageFate(input: {
  messageId: string;
  admittedVersion: string | null;
  read: Pick<ThreadSnapshotResponse, "turns" | "liveState">;
}): MessageFate {
  const { messageId, admittedVersion, read } = input;
  const record = read.liveState.runState;
  const turns = read.turns;

  let view = INITIAL_RUN_STATE_VIEW;
  if (admittedVersion !== null)
    view = addIntent(view, { kind: "message", id: messageId, answer: admittedVersion });
  view = receiveRecord(view, record);
  if (isOwed(view, messageId))
    return { kind: "waiting", blocked: isBlockedForUsage(view, messageId) };

  const message = turns.find((turn) => turn.id === messageId);
  if (!message) return { kind: "handedBack" };
  if (message.forgottenBy) return { kind: "forgotten", forgottenBy: message.forgottenBy };
  if (message.delivery === null) return { kind: "unproven", reason: "unconfirmed" };

  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const deliverer = message.delivery.byTurnId ? byId.get(message.delivery.byTurnId) : undefined;
  if (!deliverer || deliverer.executionId === null)
    return { kind: "unproven", reason: "deliverer_unknown" };

  const ordered = [...turns].sort((a, b) => a.position - b.position);
  const chain: Turn[] = [];
  const inChain = new Set<string>();
  const visited = new Set<string>();
  let executionId: string = deliverer.executionId;
  let from = deliverer.position;
  for (;;) {
    visited.add(executionId);
    for (const turn of ordered)
      if (turn.executionId === executionId && turn.position >= from && !inChain.has(turn.id)) {
        chain.push(turn);
        inChain.add(turn.id);
      }
    const retry = ordered
      .filter((turn) => {
        const target = retryTargetOf(turn);
        return (
          target !== null &&
          inChain.has(target) &&
          !inChain.has(turn.id) &&
          turn.executionId !== null &&
          !visited.has(turn.executionId)
        );
      })
      .at(-1);
    if (!retry?.executionId) break;
    executionId = retry.executionId;
    from = retry.position;
  }

  const last = chain.at(-1);
  if (!last) return { kind: "unproven", reason: "unconfirmed" };
  const found = { answeredBy: deliverer.id, chain: chain.map((turn) => turn.id), last };
  if (record.execution?.executionId === executionId) return { kind: "answering", ...found };
  if (isTerminalTurnStatus(last.status)) return { kind: "answered", ...found };
  return { kind: "unproven", reason: "unconfirmed" };
}
