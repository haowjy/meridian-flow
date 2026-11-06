/**
 * useSubagentStop — a running child's Stop, pressed from the parent's running-subagents strip.
 * It is the child chat's own Stop: the child's hand-back operation (`useHandBack` on the child's id
 * and composer draft), pressed over the child's newest record, so the child reads Stopped and its
 * queued messages come back to its message box exactly as if the writer had pressed Stop there.
 *
 * The parent holds no live copy of the child's record, and Stop cancels only the execution the
 * press names, so each press first reads the child's snapshot into the store. A read that fails
 * sent nothing; it owes the row the same "Couldn't stop" card a failed Stop does, and Try again
 * presses again.
 */
import { t } from "@lingui/core/macro";
import { classifyCommandFailure } from "@meridian/contracts/failures";
import { readRunState } from "@meridian/contracts/protocol";
import {
  type ChatCard,
  type ChatReferenceScope,
  type CommandFailure,
  handBackCards,
  logCommandFailure,
  occurrenceKey,
  type StopStatus,
  stopStatus,
} from "@meridian/thread-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getThreadSnapshot } from "@/client/api/threads-api";
import { commandFailureInput } from "@/client/failures/command-failure";
import { useFailureLog } from "@/client/failures/failure-log";
import { announce, useRunState, useThreadActions } from "@/client/stores";
import { useHandBack } from "../useHandBack";

export type SubagentStop = {
  status: StopStatus;
  /** The failures this row owes the writer, drawn under the row. */
  cards: readonly ChatCard[];
  stop: () => void;
  act: (card: ChatCard) => void;
};

type Read = { kind: "idle" } | { kind: "reading" } | { kind: "failed"; failure: CommandFailure };

export function useSubagentStop(input: {
  threadId: string;
  accountId: string;
  scope: ChatReferenceScope | null;
}): SubagentStop {
  const { threadId } = input;
  const handBack = useHandBack(input);
  const { operation, stopFacts, unresolved } = handBack;
  const actions = useThreadActions();
  const log = useFailureLog();
  const view = useRunState(threadId);
  const [read, setRead] = useState<Read>({ kind: "idle" });
  const attempts = useRef(0);
  const mounted = useRef(true);
  const status: StopStatus =
    read.kind === "reading"
      ? "pending"
      : read.kind === "failed"
        ? "failed"
        : stopStatus(view, stopFacts);
  const latest = useRef({ status, read });
  latest.current = { status, read };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const { read } = latest.current;
      if (read.kind === "failed") logCommandFailure(log, read.failure, { threadId }, "moot");
    };
  }, [log, threadId]);

  const stop = useCallback(() => {
    const { status, read } = latest.current;
    if (status === "pending" || status === "stopping") return;
    if (read.kind === "failed") logCommandFailure(log, read.failure, { threadId }, "retried");
    attempts.current += 1;
    const occurrence = { requestId: crypto.randomUUID(), attempt: attempts.current };
    setRead({ kind: "reading" });
    announce(t`Stopping`);
    getThreadSnapshot({ data: { threadId } })
      .then((snapshot) => {
        const record = readRunState(snapshot.liveState?.runState);
        if (!record) throw new Error("snapshot carries no run state");
        actions.dispatchRunState(threadId, { type: "snapshot", runState: record });
        if (!mounted.current) return;
        setRead({ kind: "idle" });
        void operation.press({ kind: "stop", view: actions.runState(threadId) });
      })
      .catch((error: unknown) => {
        const failure = { ...occurrence, ...commandFailureInput(error) };
        logCommandFailure(log, failure, { threadId });
        if (!mounted.current) {
          logCommandFailure(log, failure, { threadId }, "moot");
          return;
        }
        setRead({ kind: "failed", failure });
      });
  }, [actions, log, operation, threadId]);

  const cards: ChatCard[] =
    read.kind === "failed"
      ? [
          {
            key: occurrenceKey(read.failure),
            failure: classifyCommandFailure(read.failure),
            copy: "stop-failed",
            action: "try_again",
            anchor: "composer",
            count: 0,
            text: null,
            requestId: null,
          },
        ]
      : handBackCards(unresolved, view);

  const act = useCallback(
    (card: ChatCard) => {
      if (card.action === "dismiss" && card.requestId) operation.dismiss(card.requestId);
      else if (card.requestId) void operation.retry(card.requestId);
      else stop();
    },
    [operation, stop],
  );

  return { status, cards, stop, act };
}
