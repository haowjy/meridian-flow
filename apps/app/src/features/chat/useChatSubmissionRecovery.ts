/**
 * useChatSubmissionRecovery — reconciles durable unresolved existing-thread
 * submissions for the mounted thread.
 *
 * On mount it rebuilds one pending user row per journal entry and asks the
 * server for the admission by `submissionId`:
 *
 * - accepted admission: rename the row and retire the entry;
 * - definitive rejection: keep the failed row and retire the entry, exposing
 *   Retry (always) and Edit (only when a faithful draft can be focused or
 *   rebuilt from a plain-text fingerprint);
 * - `not-seen` (the server has no record): replay the stored fingerprint with
 *   the same `submissionId` so the displayed send is not lost;
 * - `pending`/unknown: keep both and expose Check submission status / Start
 *   over.
 *
 * `replaySubmission` shares that replay path for an in-session Check of a
 * submission whose live optimistic row recovery has never tracked (the
 * composer is still mounted, so its mount effect did not run for it).
 *
 * A live proved rejection is registered through `markRejected`, so live and
 * reload-recovered rejections share one owner, one failed-row presentation, and
 * one identity policy: Retry remints the submission id because the server never
 * re-admits a rejected `(threadId, submissionId)`. A retry's fresh id is only
 * treated as a proved rejection once the retry proves rejected; while it is
 * unresolved the journal entry is the sole witness, so a remount reconciles it
 * as Check / Start over and never offers a second reminted Retry.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ExistingThreadChatSubmission,
  getChatSubmissionAccountId,
  getChatSubmissionEpoch,
  readChatSubmissions,
  recordChatSubmission,
  retireChatSubmission,
} from "@/client/chat-submissions";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import type { ThreadStoreActions } from "@/client/stores";
import type { ComposerSubmitOutcome } from "@/components/app/composer";

export type RecoveredChatSubmission = {
  submissionId: string;
  optimisticTurnId: string;
};

/** A proved rejection retained on its user turn for edit/retry recovery. */
export type FailedChatSubmission = RecoveredChatSubmission & {
  /** The exact dispatch fingerprint, retained so Retry can remint and Edit can check faithfulness. */
  fingerprint: ExistingThreadChatSubmission;
  /**
   * Whether the live composer still holds this send's draft. A live or
   * composer-checked rejection keeps it; a reload/remount recovery resets the
   * composer, so only a plain-text-faithful fingerprint can be restored there.
   */
  draftRetained: boolean;
};

export type ChatSubmissionRecovery = {
  recovered: RecoveredChatSubmission[];
  rejected: FailedChatSubmission[];
  check: (submissionId: string) => void;
  retire: (submissionId: string) => void;
  /**
   * Record a live proved rejection against the user turn it belongs to. The
   * journal witness is retired; the row stays failed and the fingerprint is
   * retained for Retry / Edit.
   */
  markRejected: (submissionId: string, optimisticTurnId: string) => void;
  /** Re-admit a rejected submission under a fresh submission id. */
  retry: (optimisticTurnId: string) => Promise<void>;
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
 * Remember which local row belongs to each unresolved submission for the
 * session so navigating away and back reuses it instead of appending a second
 * pending row. Live sends register their row before dispatch, mount recovery
 * reuses it, and acknowledgement/proved rejection clears it.
 */
const restoredTurnIds = new Map<string, string>();

/**
 * Register the local row for an unresolved submission for the session. Called
 * by a live send immediately after it appends the row — before the POST awaits
 * admission — so a remount while the server still holds the lease reuses that
 * row instead of appending a duplicate.
 */
export function rememberSubmissionTurnId(
  accountId: string,
  submissionId: string,
  optimisticTurnId: string,
): void {
  restoredTurnIds.set(`${accountId}:${submissionId}`, optimisticTurnId);
}

/** The local row remembered for an unresolved submission, if any. */
export function submissionTurnId(accountId: string, submissionId: string): string | undefined {
  return restoredTurnIds.get(`${accountId}:${submissionId}`);
}

/** Forget a submission once it is acknowledged or proved rejected. */
export function forgetSubmissionTurnId(accountId: string, submissionId: string): void {
  restoredTurnIds.delete(`${accountId}:${submissionId}`);
}

/**
 * A proved rejection is a resolved outcome, so its durable journal entry is
 * retired. The failed row stays for edit/retry recovery, and the exact
 * dispatch fingerprint is retained here for the session so Retry can re-admit
 * under a fresh submission id (a rejected `(threadId, submissionId)` is never
 * re-admitted) and Edit can restore the message. Like `restoredTurnIds`, this
 * is session memory rather than a store, and its key fences it by account.
 */
type RetainedRejection = {
  entry: ExistingThreadChatSubmission;
  optimisticTurnId: string;
  draftRetained: boolean;
};

const rejectedSubmissions = new Map<string, RetainedRejection>();

/**
 * Drop session-scoped recovery memory: the restored row ids and the retained
 * rejection fingerprints. Used when the session's account/thread scope is
 * discarded, and between tests so module memory cannot leak across suites.
 */
export function clearChatSubmissionRecoverySession(): void {
  restoredTurnIds.clear();
  rejectedSubmissions.clear();
}

function rejectedKey(accountId: string, submissionId: string): string {
  return `${accountId}:${submissionId}`;
}

function findRetainedRejection(
  accountId: string,
  optimisticTurnId: string,
): RetainedRejection | null {
  const prefix = `${accountId}:`;
  for (const [key, retained] of rejectedSubmissions) {
    if (key.startsWith(prefix) && retained.optimisticTurnId === optimisticTurnId) {
      return retained;
    }
  }
  return null;
}

export function useChatSubmissionRecovery(
  threadId: string,
  accountId: string,
  controller: ThreadRunController,
  actions: ThreadStoreActions,
): ChatSubmissionRecovery {
  const [recovered, setRecovered] = useState<RecoveredChatSubmission[]>([]);
  const [rejected, setRejected] = useState<FailedChatSubmission[]>([]);
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

  // One stable recovery-session token per hook instance. Recovery
  // reconciliation and replay are fenced by this token rather than the
  // controller's admission epoch, because mounting this hook also mounts the
  // sibling `useChatThreadSession`, whose teardown bumps the admission epoch
  // during React StrictMode's mount/cleanup/re-mount. The token survives that
  // churn; a genuinely unmounted hook stops matching and cannot acknowledge,
  // replay, or retire.
  const [recoverySession] = useState<object>(() => ({}));

  useEffect(() => {
    const activeController = controllerRef.current;
    activeController.beginRecoverySession(recoverySession);
    return () => activeController.endRecoverySession(recoverySession);
  }, [recoverySession]);

  const dropRecovered = useCallback((submissionId: string) => {
    setRecovered((current) =>
      current.some((entry) => entry.submissionId === submissionId)
        ? current.filter((entry) => entry.submissionId !== submissionId)
        : current,
    );
  }, []);

  const raiseRecovered = useCallback((submissionId: string, optimisticTurnId: string) => {
    // Check/Start over resolve the submission back to its row through this map,
    // including a submission first raised in-session (a composer Check replay or
    // a retry that fell back to ambiguous), not only a mount-time journal entry.
    turnsRef.current.set(submissionId, optimisticTurnId);
    setRecovered((current) =>
      current.some((entry) => entry.submissionId === submissionId)
        ? current
        : [...current, { submissionId, optimisticTurnId }],
    );
  }, []);

  const raiseRejected = useCallback(
    (entry: ExistingThreadChatSubmission, optimisticTurnId: string, draftRetained: boolean) => {
      setRejected((current) =>
        current.some((candidate) => candidate.submissionId === entry.submissionId)
          ? current
          : [
              ...current,
              {
                submissionId: entry.submissionId,
                optimisticTurnId,
                fingerprint: entry,
                draftRetained,
              },
            ],
      );
    },
    [],
  );

  const dropRejected = useCallback((submissionId: string) => {
    setRejected((current) =>
      current.some((entry) => entry.submissionId === submissionId)
        ? current.filter((entry) => entry.submissionId !== submissionId)
        : current,
    );
  }, []);

  const forget = useCallback(
    (submissionId: string) => {
      forgetSubmissionTurnId(accountId, submissionId);
      rejectedSubmissions.delete(rejectedKey(accountId, submissionId));
      dropRecovered(submissionId);
      dropRejected(submissionId);
    },
    [accountId, dropRecovered, dropRejected],
  );

  /**
   * A proved rejection is an actionable failure, not a dropped send: keep the
   * user row failed, retire the rejected admission witness, and retain the
   * fingerprint for Retry/Edit. A rejected `(threadId, submissionId)` is never
   * re-admitted, so Retry remints the identity before dispatching.
   */
  const reject = useCallback(
    (entry: ExistingThreadChatSubmission, optimisticTurnId: string, draftRetained: boolean) => {
      const retainedKey = rejectedKey(accountId, entry.submissionId);
      // One retained rejection per turn: drop any earlier identity (a retry
      // replaces the rejected id) so remount cannot reattach two witnesses.
      const prefix = `${accountId}:`;
      for (const [key, retained] of rejectedSubmissions) {
        if (
          key !== retainedKey &&
          key.startsWith(prefix) &&
          retained.optimisticTurnId === optimisticTurnId
        ) {
          rejectedSubmissions.delete(key);
        }
      }
      rejectedSubmissions.set(retainedKey, { entry, optimisticTurnId, draftRetained });
      actionsRef.current.patchTurnStatus(threadId, optimisticTurnId, "error");
      // Capture the bind epoch now: a stale account must not delete the entry
      // the returned session still needs.
      retireChatSubmission(accountId, entry.submissionId, getChatSubmissionEpoch());
      forgetSubmissionTurnId(accountId, entry.submissionId);
      dropRecovered(entry.submissionId);
      raiseRejected(entry, optimisticTurnId, draftRetained);
    },
    [accountId, dropRecovered, raiseRejected, threadId],
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
      draftRetained: boolean,
    ): Promise<ComposerSubmitOutcome> => {
      const ambiguous: ComposerSubmitOutcome = {
        kind: "ambiguous",
        submissionId: entry.submissionId,
        acceptedRevision: 0,
      };
      // One dispatch per unresolved turn: this lock is shared with Retry so a
      // remount lookup cannot replay beside a retry that already reminted.
      if (replayingRef.current.has(optimisticTurnId)) {
        // Another dispatch already owns this turn. Do not re-issue; surface
        // Check so the writer can reconcile it once that dispatch settles.
        raiseRecovered(entry.submissionId, optimisticTurnId);
        return ambiguous;
      }
      replayingRef.current.add(optimisticTurnId);
      const epoch = getChatSubmissionEpoch();
      try {
        const outcome = await controllerRef.current.recoverSubmission(
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
          recoverySession,
        );
        if (unmountedRef.current) return outcome;
        if (getChatSubmissionAccountId() !== accountId) return outcome;
        if (getChatSubmissionEpoch() !== epoch) return outcome;
        if (outcome.kind === "accepted") {
          retireChatSubmission(accountId, entry.submissionId, epoch);
          forget(entry.submissionId);
          return outcome;
        }
        if (outcome.kind === "rejected") {
          reject(entry, optimisticTurnId, draftRetained);
          return outcome;
        }
        raiseRecovered(entry.submissionId, optimisticTurnId);
        return outcome;
      } finally {
        replayingRef.current.delete(optimisticTurnId);
      }
    },
    [accountId, forget, raiseRecovered, reject, recoverySession, threadId],
  );

  const settle = useCallback(
    async (
      entry: ExistingThreadChatSubmission,
      optimisticTurnId: string,
      operation: "lookup" | "retire",
      draftRetained: boolean,
    ): Promise<void> => {
      const epoch = getChatSubmissionEpoch();
      const outcome = await (operation === "retire"
        ? controllerRef.current.retireSubmission(
            threadId,
            entry.submissionId,
            { optimisticUserTurnId: optimisticTurnId },
            recoverySession,
          )
        : controllerRef.current.lookupSubmission(
            threadId,
            entry.submissionId,
            { optimisticUserTurnId: optimisticTurnId, keepOptimisticOnFailure: true },
            recoverySession,
          ));
      // Account/project lifetime fence: a stale or switched account must not
      // retire another account's entry or settle this row.
      if (unmountedRef.current) return;
      if (getChatSubmissionAccountId() !== accountId) return;
      if (getChatSubmissionEpoch() !== epoch) return;

      if (outcome.kind === "accepted") {
        retireChatSubmission(accountId, entry.submissionId, epoch);
        forget(entry.submissionId);
        return;
      }
      if (outcome.kind === "rejected") {
        if (operation === "lookup") {
          // A proved rejection keeps the failed row with edit/retry recovery.
          reject(entry, optimisticTurnId, draftRetained);
        } else {
          // Writer-directed Start over retires the witness entirely.
          retireChatSubmission(accountId, entry.submissionId, epoch);
          forget(entry.submissionId);
        }
        return;
      }
      if (outcome.kind === "not-seen" && operation === "lookup") {
        await replay(entry, optimisticTurnId, draftRetained);
        return;
      }
      if (operation === "lookup") raiseRecovered(entry.submissionId, optimisticTurnId);
    },
    [accountId, forget, raiseRecovered, reject, replay, recoverySession, threadId],
  );

  useEffect(() => {
    const bindKey = `${accountId}:${threadId}`;
    if (bindKeyRef.current !== bindKey) {
      bindKeyRef.current = bindKey;
      turnsRef.current = new Map();
      setRecovered([]);
      setRejected([]);
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
      void settle(entry, optimisticTurnId, "lookup", false);
    }

    // Reattach proved rejections retained for this session: their journal
    // witness was retired, but the failed row and its retry payload live on. A
    // row that is no longer present means the writer abandoned it, so drop the
    // stale fingerprint instead of offering a phantom Retry.
    const prefix = `${accountId}:`;
    for (const [key, retained] of rejectedSubmissions) {
      if (!key.startsWith(prefix) || retained.entry.threadId !== threadId) continue;
      if (!existingTurns.some((turn) => turn.id === retained.optimisticTurnId)) {
        rejectedSubmissions.delete(key);
        continue;
      }
      raiseRejected(retained.entry, retained.optimisticTurnId, retained.draftRetained);
    }
  }, [accountId, threadId, settle, raiseRejected]);

  const check = useCallback(
    (submissionId: string) => {
      const optimisticTurnId = turnsRef.current.get(submissionId);
      const entry = readChatSubmissions(accountId).find(
        (candidate) => candidate.submissionId === submissionId,
      );
      if (!optimisticTurnId || !entry || !isExistingThreadFor(entry, threadId)) return;
      // Check is an in-session action, but the composer may have been remounted
      // empty: do not claim a live draft, so Edit stays plain-text only.
      void settle(entry, optimisticTurnId, "lookup", false);
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
      void settle(entry, optimisticTurnId, "retire", false);
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
      return replay(entry, optimisticTurnId, true);
    },
    [accountId, replay, threadId],
  );

  const markRejected = useCallback(
    (submissionId: string, optimisticTurnId: string) => {
      const entry = readChatSubmissions(accountId).find(
        (candidate) => candidate.submissionId === submissionId,
      );
      if (!entry || !isExistingThreadFor(entry, threadId)) return;
      // The live composer still holds this draft, so Edit can focus it.
      reject(entry, optimisticTurnId, true);
    },
    [accountId, reject, threadId],
  );

  const retry = useCallback(
    async (optimisticTurnId: string) => {
      const retained = findRetainedRejection(accountId, optimisticTurnId);
      if (!retained || retained.entry.threadId !== threadId) return;
      const entry = retained.entry;
      const turns = actionsRef.current.turns(threadId) ?? [];
      if (!turns.some((turn) => turn.id === optimisticTurnId)) {
        // The writer abandoned the row: forget the retained fingerprint.
        rejectedSubmissions.delete(rejectedKey(accountId, entry.submissionId));
        dropRejected(entry.submissionId);
        return;
      }
      // One dispatch per unresolved turn: this lock is shared with journal
      // replay so a remount lookup cannot re-issue beside this retry.
      if (replayingRef.current.has(optimisticTurnId)) return;
      replayingRef.current.add(optimisticTurnId);
      const epoch = getChatSubmissionEpoch();
      // A rejected `(threadId, submissionId)` is never re-admitted: mint a
      // fresh identity and record the durable intent before dispatch.
      const nextEntry: ExistingThreadChatSubmission = {
        ...entry,
        submissionId: crypto.randomUUID(),
      };
      try {
        if (!recordChatSubmission(accountId, nextEntry)) {
          // Durable witness refused: keep the failed row and its Retry/Edit.
          actionsRef.current.patchTurnStatus(threadId, optimisticTurnId, "error");
          return;
        }
        retireChatSubmission(accountId, entry.submissionId, epoch);
        // The fresh journal entry now owns the unresolved send. Drop the proved
        // rejection so a remount resolves through lookup (Check / Start over)
        // instead of reattaching Retry for an unresolved retry.
        rejectedSubmissions.delete(rejectedKey(accountId, entry.submissionId));
        forgetSubmissionTurnId(accountId, entry.submissionId);
        rememberSubmissionTurnId(accountId, nextEntry.submissionId, optimisticTurnId);
        actionsRef.current.patchTurnStatus(threadId, optimisticTurnId, "pending");
        dropRejected(entry.submissionId);

        let outcome: ComposerSubmitOutcome;
        try {
          outcome = await controllerRef.current.recoverSubmission(
            threadId,
            {
              submissionId: nextEntry.submissionId,
              acceptedRevision: 0,
              text: nextEntry.text,
              blocks: nextEntry.blocks,
              references: nextEntry.references,
              activatedSkillSlugs: nextEntry.activatedSkillSlugs,
            },
            { optimisticUserTurnId: optimisticTurnId, keepOptimisticOnFailure: true },
            recoverySession,
          );
        } catch {
          // A throw is ambiguous: leave the fresh journal witness untouched.
          outcome = {
            kind: "ambiguous",
            submissionId: nextEntry.submissionId,
            acceptedRevision: 0,
          };
        }
        // A stale session must not present state for another account/epoch; the
        // fresh journal entry is reconciled by the next mount's lookup.
        if (unmountedRef.current) return;
        if (getChatSubmissionAccountId() !== accountId) return;
        if (getChatSubmissionEpoch() !== epoch) return;
        if (outcome.kind === "accepted") {
          retireChatSubmission(accountId, nextEntry.submissionId, epoch);
          forget(nextEntry.submissionId);
          return;
        }
        if (outcome.kind === "rejected") {
          reject(nextEntry, optimisticTurnId, retained.draftRetained);
          return;
        }
        // Ambiguous / not-seen: the journal entry stays unresolved and the turn
        // offers Check / Start over, never a second reminted Retry.
        raiseRecovered(nextEntry.submissionId, optimisticTurnId);
      } finally {
        replayingRef.current.delete(optimisticTurnId);
      }
    },
    [accountId, dropRejected, forget, raiseRecovered, recoverySession, reject, threadId],
  );

  return { recovered, rejected, check, retire, markRejected, retry, replaySubmission };
}
