/**
 * useChatSubmissionRecovery — reconciles durable unresolved existing-thread
 * submissions for the mounted thread.
 *
 * On mount it rebuilds one pending user row per journal entry and asks the
 * server for the admission by `submissionId`:
 *
 * - accepted admission: rename the row and retire the entry;
 * - definitive rejection: leave the failed row, retire the entry;
 * - `not-seen` (the server has no record): replay the stored fingerprint with
 *   the same `submissionId` so the displayed send is not lost;
 * - `pending`/unknown: keep both and expose Check submission status / Start
 *   over.
 *
 * `replaySubmission` shares that replay path for an in-session Check of a
 * submission whose live optimistic row recovery has never tracked (the
 * composer is still mounted, so its mount effect did not run for it).
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
import type { ComposerSubmitOutcome } from "@/components/app/composer";
import { shouldRetireSubmission } from "./chat-submission-retirement";

export type RecoveredChatSubmission = {
  submissionId: string;
  optimisticTurnId: string;
};

export type ChatSubmissionRecovery = {
  recovered: RecoveredChatSubmission[];
  check: (submissionId: string) => void;
  retire: (submissionId: string) => void;
  /**
   * In-session re-admission for a live optimistic row recovery has not tracked
   * (the composer Check path). Replays the stored fingerprint through the same
   * path as mount recovery with the caller's live optimistic turn id.
   */
  replaySubmission: (
    submissionId: string,
    optimisticTurnId: string,
  ) => Promise<ComposerSubmitOutcome>;
};

function isExistingThreadFor(
  entry: { kind: string; threadId: string },
  threadId: string,
): entry is ExistingThreadChatSubmission {
  return entry.kind === "existing-thread" && entry.threadId === threadId;
}

/**
 * The thread store outlives a ChatView mount, but a component ref does not.
 * Remember which restored local row belongs to each unresolved submission for
 * the session so navigating away and back reuses it instead of appending a
 * second pending row. Cleared on acknowledgement/rejection.
 */
const restoredTurnIds = new Map<string, string>();

export function useChatSubmissionRecovery(
  threadId: string,
  accountId: string,
  controller: ThreadRunController,
  actions: ThreadStoreActions,
): ChatSubmissionRecovery {
  const [recovered, setRecovered] = useState<RecoveredChatSubmission[]>([]);
  const turnsRef = useRef(new Map<string, string>());
  const bindKeyRef = useRef("");
  const replayingRef = useRef(new Set<string>());
  // A settle that resolves after unmount must not retire or mutate the store:
  // the next session owns the entry and will reconcile it again.
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

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

  const forget = useCallback(
    (submissionId: string) => {
      restoredTurnIds.delete(`${accountId}:${submissionId}`);
      dropRecovered(submissionId);
    },
    [accountId, dropRecovered],
  );

  /**
   * The lookup proved the server never saw this submission. Re-issue the exact
   * stored fingerprint with the same `submissionId`; because the identity is
   * stable, a concurrent duplicate admission collapses instead of running twice.
   * Returns the dispatch outcome so an in-session Check can settle the composer.
   */
  const replay = useCallback(
    async (
      entry: ExistingThreadChatSubmission,
      optimisticTurnId: string,
    ): Promise<ComposerSubmitOutcome> => {
      const ambiguous: ComposerSubmitOutcome = {
        kind: "ambiguous",
        submissionId: entry.submissionId,
        acceptedRevision: 0,
      };
      if (replayingRef.current.has(entry.submissionId)) return ambiguous;
      replayingRef.current.add(entry.submissionId);
      const epoch = getChatSubmissionEpoch();
      try {
        const outcome = await controllerRef.current.submit(
          threadId,
          {
            submissionId: entry.submissionId,
            acceptedRevision: 0,
            text: entry.text,
            blocks: entry.blocks,
            references: entry.references,
            activatedSkillSlugs: entry.activatedSkillSlugs,
          },
          { optimisticUserTurnId: optimisticTurnId, keepOptimisticOnFailure: true },
        );
        if (unmountedRef.current) return outcome;
        if (getChatSubmissionAccountId() !== accountId) return outcome;
        if (getChatSubmissionEpoch() !== epoch) return outcome;
        if (shouldRetireSubmission(outcome)) {
          retireChatSubmission(accountId, entry.submissionId, epoch);
          if (outcome.kind === "rejected") {
            actionsRef.current.patchTurnStatus(threadId, optimisticTurnId, "error");
          }
          forget(entry.submissionId);
          return outcome;
        }
        raiseRecovered(entry.submissionId, optimisticTurnId);
        return outcome;
      } finally {
        replayingRef.current.delete(entry.submissionId);
      }
    },
    [accountId, forget, raiseRecovered, threadId],
  );

  const settle = useCallback(
    async (
      entry: ExistingThreadChatSubmission,
      optimisticTurnId: string,
      operation: "lookup" | "retire",
    ): Promise<void> => {
      const epoch = getChatSubmissionEpoch();
      const outcome = await (operation === "retire"
        ? controllerRef.current.retireSubmission(threadId, entry.submissionId, {
            optimisticUserTurnId: optimisticTurnId,
          })
        : controllerRef.current.lookupSubmission(threadId, entry.submissionId, {
            optimisticUserTurnId: optimisticTurnId,
            keepOptimisticOnFailure: true,
          }));
      // Account/project lifetime fence: a stale or switched account must not
      // retire another account's entry or settle this row.
      if (unmountedRef.current) return;
      if (getChatSubmissionAccountId() !== accountId) return;
      if (getChatSubmissionEpoch() !== epoch) return;

      if (shouldRetireSubmission(outcome)) {
        retireChatSubmission(accountId, entry.submissionId, epoch);
        if (outcome.kind === "rejected" && operation === "lookup") {
          actionsRef.current.patchTurnStatus(threadId, optimisticTurnId, "error");
        }
        forget(entry.submissionId);
        return;
      }
      if (outcome.kind === "not-seen" && operation === "lookup") {
        await replay(entry, optimisticTurnId);
        return;
      }
      if (operation === "lookup") raiseRecovered(entry.submissionId, optimisticTurnId);
    },
    [accountId, forget, raiseRecovered, replay, threadId],
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
    const existingTurns = actionsRef.current.turns(threadId) ?? [];
    for (const entry of entries) {
      if (turnsRef.current.has(entry.submissionId)) continue;
      const mapKey = `${accountId}:${entry.submissionId}`;
      let optimisticTurnId = restoredTurnIds.get(mapKey);
      if (!optimisticTurnId || !existingTurns.some((turn) => turn.id === optimisticTurnId)) {
        optimisticTurnId = actionsRef.current.appendUserTurn(threadId, entry.text).id;
        restoredTurnIds.set(mapKey, optimisticTurnId);
      }
      turnsRef.current.set(entry.submissionId, optimisticTurnId);
      void settle(entry, optimisticTurnId, "lookup");
    }
  }, [accountId, threadId, settle]);

  const check = useCallback(
    (submissionId: string) => {
      const optimisticTurnId = turnsRef.current.get(submissionId);
      const entry = readChatSubmissions(accountId).find(
        (candidate) => candidate.submissionId === submissionId,
      );
      if (!optimisticTurnId || !entry || !isExistingThreadFor(entry, threadId)) return;
      void settle(entry, optimisticTurnId, "lookup");
    },
    [accountId, settle, threadId],
  );

  const retire = useCallback(
    (submissionId: string) => {
      const optimisticTurnId = turnsRef.current.get(submissionId);
      const entry = readChatSubmissions(accountId).find(
        (candidate) => candidate.submissionId === submissionId,
      );
      if (!optimisticTurnId || !entry || !isExistingThreadFor(entry, threadId)) return;
      void settle(entry, optimisticTurnId, "retire");
    },
    [accountId, settle, threadId],
  );

  const replaySubmission = useCallback(
    (submissionId: string, optimisticTurnId: string): Promise<ComposerSubmitOutcome> => {
      const entry = readChatSubmissions(accountId).find(
        (candidate) => candidate.submissionId === submissionId,
      );
      if (!entry || !isExistingThreadFor(entry, threadId)) {
        return Promise.resolve({
          kind: "ambiguous",
          submissionId,
          acceptedRevision: 0,
        });
      }
      return replay(entry, optimisticTurnId);
    },
    [accountId, replay, threadId],
  );

  return { recovered, check, retire, replaySubmission };
}
