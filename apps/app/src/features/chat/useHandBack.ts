/**
 * useHandBack — the chat's hand-back operation (`@meridian/thread-client`) wired to this tab:
 * the composer draft as its store, the run-state slice as its record and intents, the
 * transcript store for removed turns, and `fetch` for the post. Stop, the queue's x and Cancel
 * queue all press the one operation this hook creates, so its unresolved commands (the cards)
 * are shared too.
 *
 * The package decides everything (identity, order, answers, which failures owe a card); this file
 * is adapters. A reload re-posts every command the draft still holds (`resume`), and a change
 * to the draft re-checks what still owes a card (`reconcile`).
 */
import {
  type ChatReferenceScope,
  chatReferenceResolver,
  composerDocFromHandedBack,
  createHandBackOperation,
  type HandBackOperation,
  type HandBackPorts,
  type RunStatePort,
  type StopFacts,
  type UnresolvedHandBack,
} from "@meridian/thread-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postCommand } from "@/client/api/threads-api";
import { composerSessionDraft } from "@/client/composer-drafts";
import { useThreadActions } from "@/client/stores";

export type ChatHandBack = {
  operation: HandBackOperation;
  /** Commands that still owe the writer a card, newest state. */
  unresolved: readonly UnresolvedHandBack[];
  /** What the Stop control reads from the operation, the same on every route into it. */
  stopFacts: StopFacts;
};

export function useHandBack(input: {
  threadId: string;
  accountId: string;
  /** Where the chat's handed-back references live; null until the chat has loaded. */
  scope: ChatReferenceScope | null;
}): ChatHandBack {
  const { threadId, accountId, scope } = input;
  const actions = useThreadActions();
  const latest = useRef({ actions, scope });
  latest.current = { actions, scope };
  const [revision, setRevision] = useState(0);
  const redraw = useCallback(() => setRevision((n) => n + 1), []);

  const draft = useMemo(
    () => composerSessionDraft(accountId, { kind: "chat", id: threadId }),
    [accountId, threadId],
  );
  const operation = useMemo(() => {
    const runState: RunStatePort = {
      receive: (record) =>
        latest.current.actions.dispatchRunState(threadId, { type: "snapshot", runState: record }),
      addIntent: (id, candidates) =>
        latest.current.actions.dispatchRunState(threadId, {
          type: "intent",
          intent: { kind: "handBack", id, candidates, failed: false, answer: null },
        }),
      answerIntent: (id, version) =>
        latest.current.actions.dispatchRunState(threadId, {
          type: "answer",
          kind: "handBack",
          id,
          version,
        }),
      failIntent: (id) =>
        latest.current.actions.dispatchRunState(threadId, { type: "failHandBack", id }),
      dropIntent: (id) =>
        latest.current.actions.dispatchRunState(threadId, { type: "drop", kind: "handBack", id }),
    };
    const store: HandBackPorts["store"] = {
      pending: () => draft.handBacks,
      record: (command) => draft.recordHandBack(command),
      accept: (requestId, handedBack) => {
        const where = latest.current.scope;
        // Without the chat's facts a reference comes back as its link text.
        const resolve = where ? chatReferenceResolver(where) : () => null;
        return draft.receiveHandBack(requestId, composerDocFromHandedBack(handedBack, resolve));
      },
      drop: (requestId) => draft.dropHandBack(requestId),
    };
    return createHandBackOperation({
      threadId,
      ports: {
        http: postCommand,
        runState,
        removeTurns: (ids, version) => latest.current.actions.removeTurns(threadId, ids, version),
        store,
      },
    });
  }, [draft, threadId]);

  useEffect(() => {
    const stopListening = operation.subscribe(redraw);
    void operation.resume();
    const stopWatching = draft.subscribe(() => operation.reconcile());
    return () => {
      stopListening();
      stopWatching();
    };
  }, [draft, operation, redraw]);

  const unresolved = useMemo(() => operation.unresolved(), [operation, revision]);
  const stopFacts = useMemo(() => operation.stopFacts(), [operation, revision]);
  return { operation, unresolved, stopFacts };
}
