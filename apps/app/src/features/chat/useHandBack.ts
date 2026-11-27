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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { postCommand } from "@/client/api/threads-api";
import { composerSessionDraft } from "@/client/chat-submissions/composer-drafts";
import { useFailureLog } from "@/client/failures/failure-log";
import { useRunState, useThreadActions } from "@/client/stores";

export type ChatHandBack = {
  operation: HandBackOperation;
  unresolved: readonly UnresolvedHandBack[];
  stopFacts: StopFacts;
};

export function useHandBack(input: {
  threadId: string;
  accountId: string;
  scope: ChatReferenceScope | null;
}): ChatHandBack {
  const { threadId, accountId, scope } = input;
  const actions = useThreadActions();
  const failureLog = useFailureLog();
  const view = useRunState(threadId);
  const latest = useRef({ actions, scope });
  useLayoutEffect(() => {
    latest.current = { actions, scope };
  }, [actions, scope]);
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
        const resolve = where ? chatReferenceResolver(where) : () => null;
        return draft.receiveHandBack(requestId, composerDocFromHandedBack(handedBack, resolve));
      },
      drop: (requestId) => draft.dropHandBack(requestId),
    };
    return createHandBackOperation({
      threadId,
      ports: {
        failureLog,
        http: postCommand,
        runState,
        removeTurns: (ids, version) => latest.current.actions.removeTurns(threadId, ids, version),
        store,
      },
    });
  }, [draft, threadId, failureLog]);

  useEffect(() => {
    operation.open();
    const stopListening = operation.subscribe(redraw);
    void operation.resume();
    const stopWatching = draft.subscribe(() => operation.reconcile());
    return () => {
      stopListening();
      stopWatching();
      operation.close();
    };
  }, [draft, operation, redraw]);

  useEffect(() => operation.reconcile(view), [operation, view]);

  const unresolved = useMemo(() => operation.unresolved(), [operation, revision]);
  const stopFacts = useMemo(() => operation.stopFacts(), [operation, revision]);
  return { operation, unresolved, stopFacts };
}
