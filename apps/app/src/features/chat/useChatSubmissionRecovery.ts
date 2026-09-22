/**
 * useChatSubmissionRecovery — reconciles durable unresolved existing-thread
 * submissions for the mounted thread.
 *
 * On mount it rebuilds one pending user row per journal entry and asks the
 * server for the admission by `submissionId`. An accepted admission renames the
 * row and retires the entry; a definitive rejection leaves the row failed and
 * retires the entry; an ambiguous admission keeps both and exposes the same
 * Check submission status / Start over controls the live composer offers.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ExistingThreadChatSubmission,
  getChatSubmissionAccountId,
  getChatSubmissionEpoch,
  readChatSubmissions,
  retireChatSubmission,
} from "@/client/chat-submissions";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import type { ThreadStoreActions } from "@/client/stores";

export type RecoveredChatSubmission = {
  submissionId: string;
  optimisticTurnId: string;
};

export type ChatSubmissionRecovery = {
  recovered: RecoveredChatSubmission[];
  check: (submissionId: string) => void;
  retire: (submissionId: string) => void;
};

function isExistingThreadFor(
  entry: { kind: string; threadId: string },
  threadId: string,
): entry is ExistingThreadChatSubmission {
  return entry.kind === "existing-thread" && entry.threadId === threadId;
}

export function useChatSubmissionRecovery(
  threadId: string,
  accountId: string,
  controller: ThreadRunController,
  actions: ThreadStoreActions,
): ChatSubmissionRecovery {
  const [recovered, setRecovered] = useState<RecoveredChatSubmission[]>([]);
  const turnsRef = useRef(new Map<string, string>());
  const bindKeyRef = useRef("");

  // Keep the latest collaborators in refs so the recovery effect keys only on
  // the account/thread identity. Re-running it on every action identity change
  // would re-append rows.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  const dropRecovered = useCallback((submissionId: string) => {
    setRecovered((current) =>
      current.some((entry) => entry.submissionId === submissionId)
        ? current.filter((entry) => entry.submissionId !== submissionId)
        : current,
    );
  }, []);

  const raiseRecovered = useCallback((submissionId: string, optimisticTurnId: string) => {
    setRecovered((current) =>
      current.some((entry) => entry.submissionId === submissionId)
        ? current
        : [...current, { submissionId, optimisticTurnId }],
    );
  }, []);

  const settle = useCallback(
    async (
      submissionId: string,
      optimisticTurnId: string,
      operation: "lookup" | "retire",
    ): Promise<void> => {
      const epoch = getChatSubmissionEpoch();
      const outcome = await (operation === "retire"
        ? controllerRef.current.retireSubmission(threadId, submissionId, {
            optimisticUserTurnId: optimisticTurnId,
          })
        : controllerRef.current.lookupSubmission(threadId, submissionId, {
            optimisticUserTurnId: optimisticTurnId,
            keepOptimisticOnFailure: true,
          }));
      // Account/project lifetime fence: a stale or switched account must not
      // retire another account's entry or settle this row.
      if (getChatSubmissionAccountId() !== accountId) return;
      if (getChatSubmissionEpoch() !== epoch) return;

      if (outcome.kind === "accepted") {
        retireChatSubmission(accountId, submissionId);
        dropRecovered(submissionId);
        return;
      }
      if (outcome.kind === "rejected") {
        retireChatSubmission(accountId, submissionId);
        if (operation === "lookup") {
          actionsRef.current.patchTurnStatus(threadId, optimisticTurnId, "error");
        }
        dropRecovered(submissionId);
        return;
      }
      if (operation === "lookup") raiseRecovered(submissionId, optimisticTurnId);
    },
    [accountId, dropRecovered, raiseRecovered, threadId],
  );

  useEffect(() => {
    const bindKey = `${accountId}:${threadId}`;
    if (bindKeyRef.current !== bindKey) {
      bindKeyRef.current = bindKey;
      turnsRef.current = new Map();
      setRecovered([]);
    }

    const entries = readChatSubmissions(accountId).filter((entry) =>
      isExistingThreadFor(entry, threadId),
    );
    for (const entry of entries) {
      if (turnsRef.current.has(entry.submissionId)) continue;
      const turn = actionsRef.current.appendUserTurn(threadId, entry.text);
      turnsRef.current.set(entry.submissionId, turn.id);
      void settle(entry.submissionId, turn.id, "lookup");
    }
  }, [accountId, threadId, settle]);

  const check = useCallback(
    (submissionId: string) => {
      const optimisticTurnId = turnsRef.current.get(submissionId);
      if (!optimisticTurnId) return;
      void settle(submissionId, optimisticTurnId, "lookup");
    },
    [settle],
  );

  const retire = useCallback(
    (submissionId: string) => {
      const optimisticTurnId = turnsRef.current.get(submissionId);
      if (!optimisticTurnId) return;
      void settle(submissionId, optimisticTurnId, "retire");
    },
    [settle],
  );

  return { recovered, check, retire };
}
