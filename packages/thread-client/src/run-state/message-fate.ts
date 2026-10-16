/**
 * `messageFate`: what became of one admitted writer message, proven from a single snapshot read.
 *
 * Inputs are one read's `record` and `turns` plus the admission's version; stream frames are
 * never inputs (they only decide when a client reads). The rules are built from the shared
 * pieces the app runs (`receiveRecord`, `addIntent`, `isOwed`, `isBlockedForUsage`,
 * `retryTargetOf`), so `./mf` decides nothing about a reply itself.
 *
 * Contract with the snapshot: a user turn missing from `turns` is read as HANDED BACK
 * (`buildThreadSnapshot` filters only `listHandedBackIds`). A snapshot that pages or hides
 * turns any other way must expose `handedBackIds` and this selector must read them, or an
 * absent turn would be claimed as a hand-back it was not.
 *
 * A stamped writer message (`forgottenBy`) is FORGOTTEN, never answered. Forgotten reply turns stay
 * findable below: a failed reply followed by a successful Retry still proves the Retry.
 *
 * The answer is the last reply in the message's chain: the deliverer's execution from the
 * deliverer on, then each Retry's execution (`metadata.retryOf`), so a failed or cancelled
 * successor can never fall back to an earlier reply's success.
 */
import {
  isTerminalTurnStatus,
  type RunState,
  retryTargetOf,
  type Turn,
} from "@meridian/contracts/threads";
import { isBlockedForUsage, isOwed } from "./fold-messages";
import { addIntent, INITIAL_RUN_STATE_VIEW, receiveRecord } from "./run-state-view";

export type MessageFate =
  | { kind: "waiting"; blocked: boolean }
  | { kind: "handedBack" }
  /**
   * The chat moved past this message's failed attempt: a stamped writer message left the
   * conversation, so no reply answers it. Not success, not a hand-back; `forgottenBy` is the
   * turn that moved on.
   */
  | { kind: "forgotten"; forgottenBy: string }
  | { kind: "answering"; answeredBy: string; chain: string[]; last: Turn }
  /** `last.status` is terminal. */
  | { kind: "answered"; answeredBy: string; chain: string[]; last: Turn }
  | { kind: "unproven"; reason: "deliverer_unknown" | "unconfirmed" };

/** `record` and `turns` must come from one read (a snapshot). Stream frames are not inputs. */
export function messageFate(input: {
  messageId: string;
  admittedVersion: string | null;
  record: RunState;
  turns: readonly Turn[];
}): MessageFate {
  const { messageId, admittedVersion, record, turns } = input;

  // A record older than the admission keeps the intent, so it reads as waiting, never gone.
  let view = INITIAL_RUN_STATE_VIEW;
  if (admittedVersion !== null)
    view = addIntent(view, { kind: "message", id: messageId, answer: admittedVersion });
  view = receiveRecord(view, record);
  if (isOwed(view, messageId))
    return { kind: "waiting", blocked: isBlockedForUsage(view, messageId) };

  const message = turns.find((turn) => turn.id === messageId);
  if (!message) return { kind: "handedBack" };
  // Before any answer is attributed: a later reply belongs to the turn that moved on, not to this message.
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
