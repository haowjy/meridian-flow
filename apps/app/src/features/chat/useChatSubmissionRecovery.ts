/** Reconciles and retries persisted chat submissions. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ExistingThreadChatSubmission,
  getChatSubmissionAccountId,
  getChatSubmissionEpoch,
  readChatSubmissions,
  recordChatSubmission,
  retireChatSubmission,
  settleChatSubmission,
} from "@/client/chat-submissions";
import { composerSessionDraft } from "@/client/composer-drafts";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import type { ThreadStoreActions } from "@/client/stores";
import type { ComposerSubmitOutcome } from "@/components/app/composer";
import { whenDerived } from "./derivation/derive-conversation";

export type RecoveredChatSubmission = {
  submissionId: string;
  optimisticTurnId: string;
};

/** A proved rejection retained on its user turn for edit/retry recovery. */
export type FailedChatSubmission = RecoveredChatSubmission & {
  /** The exact dispatch fingerprint, retained so Retry can remint and Edit can check faithfulness. */
  fingerprint: ExistingThreadChatSubmission;
};

export type ChatSubmissionRecovery = {
  recovered: RecoveredChatSubmission[];
  rejected: FailedChatSubmission[];
  check: (submissionId: string) => void;
  retire: (submissionId: string) => void;
  markRejected: (submissionId: string, optimisticTurnId: string) => void;
  edit: (submissionId: string) => boolean;
  /** Re-admit a rejected submission under a fresh submission id. */
  retry: (optimisticTurnId: string) => Promise<void>;
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

const restoredTurnIds = new Map<string, string>();

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

/** Drop transient row identities; rejected payloads belong to the device journal. */
export function clearChatSubmissionRecoverySession(): void {
  restoredTurnIds.clear();
}

export function useChatSubmissionRecovery(
  threadId: string,
  accountId: string,
  controller: ThreadRunController,
  actions: ThreadStoreActions,
): ChatSubmissionRecovery {
  const bindEpoch = useMemo(() => getChatSubmissionEpoch(), [accountId]);
  const [recovered, setRecovered] = useState<RecoveredChatSubmission[]>([]);
  const [rejected, setRejected] = useState<FailedChatSubmission[]>([]);
  const rejectedRef = useRef(rejected);
  rejectedRef.current = rejected;
  const turnsRef = useRef(new Map<string, string>());
  const bindKeyRef = useRef("");
  const replayingRef = useRef(new Set<string>());
  // Asynchronous lookup/replay stops after unmount. A direct proved rejection
  // still transfers authoring through the account-fenced submission owner.
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
    (entry: ExistingThreadChatSubmission, optimisticTurnId: string) => {
      setRejected((current) =>
        current.some((candidate) => candidate.submissionId === entry.submissionId)
          ? current
          : [
              ...current,
              {
                submissionId: entry.submissionId,
                optimisticTurnId,
                fingerprint: entry,
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
      dropRecovered(submissionId);
      dropRejected(submissionId);
    },
    [accountId, dropRecovered, dropRejected],
  );

  /** A proved rejection is an actionable failure, not a dropped send: keep the user row failed and transfer ownership to authoring or a rejected journal entry. */
  const reject = useCallback(
    (entry: ExistingThreadChatSubmission, optimisticTurnId: string) => {
      if (getChatSubmissionAccountId() !== accountId || getChatSubmissionEpoch() !== bindEpoch)
        return;
      rememberSubmissionTurnId(accountId, entry.submissionId, optimisticTurnId);
      turnsRef.current.set(entry.submissionId, optimisticTurnId);
      actionsRef.current.patchTurnStatus(threadId, optimisticTurnId, "error");
      // A refused storage transfer keeps both the witness and its row identity.
      settleChatSubmission(accountId, entry.submissionId, "rejected", bindEpoch);
      dropRecovered(entry.submissionId);
      const owned = readChatSubmissions(accountId).find(
        (candidate) => candidate.submissionId === entry.submissionId,
      );
      raiseRejected(
        owned && isExistingThreadFor(owned, threadId) ? owned : entry,
        optimisticTurnId,
      );
    },
    [accountId, bindEpoch, dropRecovered, raiseRejected, threadId],
  );

  /** The lookup proved the server never saw this submission. */
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
        if (!(await whenDerived(threadId))) {
          if (unmountedRef.current) return ambiguous;
          if (getChatSubmissionAccountId() !== accountId) return ambiguous;
          if (getChatSubmissionEpoch() !== epoch) return ambiguous;
          reject(entry, optimisticTurnId);
          return { ...ambiguous, kind: "rejected" };
        }
        const pending = readChatSubmissions(accountId).find(
          (candidate) => candidate.submissionId === entry.submissionId,
        );
        if (!pending || (pending.kind === "existing-thread" && pending.state === "rejected"))
          return ambiguous;
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
          if (settleChatSubmission(accountId, entry.submissionId, "accepted", epoch))
            forget(entry.submissionId);
          return outcome;
        }
        if (outcome.kind === "rejected") {
          reject(entry, optimisticTurnId);
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
    ): Promise<void> => {
      const epoch = getChatSubmissionEpoch();
      // A fork or handoff reloaded mid-creation: the server has no thread to
      // look the send up in until creation lands. If it never does, the send
      // fails with it, as a live send does.
      const threadExists = await whenDerived(threadId);
      if (unmountedRef.current) return;
      if (getChatSubmissionAccountId() !== accountId) return;
      if (getChatSubmissionEpoch() !== epoch) return;
      const pending = readChatSubmissions(accountId).find(
        (candidate) => candidate.submissionId === entry.submissionId,
      );
      if (!pending || (pending.kind === "existing-thread" && pending.state === "rejected")) return;
      if (!threadExists) {
        if (operation === "lookup") reject(entry, optimisticTurnId);
        else {
          retireChatSubmission(accountId, entry.submissionId, epoch);
          forget(entry.submissionId);
        }
        return;
      }
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
      const latest = readChatSubmissions(accountId).find(
        (candidate) => candidate.submissionId === entry.submissionId,
      );
      if (!latest || (latest.kind === "existing-thread" && latest.state === "rejected")) return;

      if (outcome.kind === "accepted") {
        if (settleChatSubmission(accountId, entry.submissionId, "accepted", epoch))
          forget(entry.submissionId);
        return;
      }
      if (outcome.kind === "rejected") {
        if (operation === "lookup") {
          // A proved rejection keeps the failed row with edit/retry recovery.
          reject(entry, optimisticTurnId);
        } else {
          // Writer-directed Start over retires the witness entirely.
          retireChatSubmission(accountId, entry.submissionId, epoch);
          forget(entry.submissionId);
        }
        return;
      }
      if (outcome.kind === "not-seen" && operation === "lookup") {
        await replay(entry, optimisticTurnId);
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

    const synchronize = () => {
      const entries = readChatSubmissions(accountId).filter((entry) =>
        isExistingThreadFor(entry, threadId),
      );
      const durableIds = new Set(entries.map((entry) => entry.submissionId));
      for (const failed of rejectedRef.current) {
        if (failed.fingerprint.state === "rejected" && !durableIds.has(failed.submissionId)) {
          forget(failed.submissionId);
        }
      }
      const existingTurns = actionsRef.current.turns(threadId) ?? [];
      for (const entry of entries) {
        const knownTurn = turnsRef.current.get(entry.submissionId);
        if (knownTurn) {
          if (entry.state === "rejected") {
            dropRecovered(entry.submissionId);
            actionsRef.current.patchTurnStatus(threadId, knownTurn, "error");
            raiseRejected(entry, knownTurn);
          }
          continue;
        }
        const mapKey = `${accountId}:${entry.submissionId}`;
        let optimisticTurnId = restoredTurnIds.get(mapKey);
        if (!optimisticTurnId || !existingTurns.some((turn) => turn.id === optimisticTurnId)) {
          optimisticTurnId = actionsRef.current.appendUserTurn(threadId, entry.blocks).id;
          restoredTurnIds.set(mapKey, optimisticTurnId);
        }
        turnsRef.current.set(entry.submissionId, optimisticTurnId);
        if (entry.state === "rejected") {
          actionsRef.current.patchTurnStatus(threadId, optimisticTurnId, "error");
          raiseRejected(entry, optimisticTurnId);
        } else void settle(entry, optimisticTurnId, "lookup");
      }
    };
    synchronize();
    window.addEventListener("storage", synchronize);
    return () => window.removeEventListener("storage", synchronize);
  }, [accountId, threadId, settle, raiseRejected, dropRecovered, forget]);

  const check = useCallback(
    (submissionId: string) => {
      const optimisticTurnId = turnsRef.current.get(submissionId);
      const entry = readChatSubmissions(accountId).find(
        (candidate) => candidate.submissionId === submissionId,
      );
      if (
        !optimisticTurnId ||
        !entry ||
        !isExistingThreadFor(entry, threadId) ||
        entry.state === "rejected"
      )
        return;
      // Check is an in-session action, but the composer may have been remounted
      // empty: do not claim a live draft, the lifecycle owner restores the structured snapshot.
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

  const markRejected = useCallback(
    (submissionId: string, optimisticTurnId: string) => {
      const entry = readChatSubmissions(accountId).find(
        (candidate) => candidate.submissionId === submissionId,
      );
      if (!entry || !isExistingThreadFor(entry, threadId)) return;
      // The submission lifecycle transfers words even when its pane is gone.
      reject(entry, optimisticTurnId);
    },
    [accountId, reject, threadId],
  );

  const retry = useCallback(
    async (optimisticTurnId: string) => {
      const retained = rejectedRef.current.find(
        (candidate) => candidate.optimisticTurnId === optimisticTurnId,
      );
      if (!retained || retained.fingerprint.threadId !== threadId) return;
      // A send that failed with its fork's creation stays failed until the
      // fork exists; retrying creation is the destination's own Retry.
      if (!(await whenDerived(threadId)) || unmountedRef.current) return;
      const entry = retained.fingerprint;
      const turns = actionsRef.current.turns(threadId) ?? [];
      if (!turns.some((turn) => turn.id === optimisticTurnId)) {
        // The writer abandoned the row: forget the retained fingerprint.
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
        state: undefined,
      };
      try {
        if (!recordChatSubmission(accountId, nextEntry, entry.state !== "rejected")) {
          // Durable witness refused: keep the failed row and its Retry/Edit.
          actionsRef.current.patchTurnStatus(threadId, optimisticTurnId, "error");
          return;
        }
        retireChatSubmission(accountId, entry.submissionId, epoch);
        // The fresh journal entry now owns the unresolved send. Drop the proved
        // rejection so a remount resolves through lookup (Check / Start over)
        // instead of reattaching Retry for an unresolved retry.
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
          if (settleChatSubmission(accountId, nextEntry.submissionId, "accepted", epoch))
            forget(nextEntry.submissionId);
          return;
        }
        if (outcome.kind === "rejected") {
          reject(nextEntry, optimisticTurnId);
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

  const edit = useCallback(
    (submissionId: string) => {
      if (getChatSubmissionAccountId() !== accountId || getChatSubmissionEpoch() !== bindEpoch)
        return false;
      const failed = rejectedRef.current.find(
        (candidate) => candidate.submissionId === submissionId,
      );
      if (!failed?.fingerprint.draft) return false;
      const entry = readChatSubmissions(accountId).find(
        (candidate) => candidate.submissionId === submissionId,
      );
      if (
        entry &&
        !composerSessionDraft(accountId, { kind: "chat", id: threadId }).editRejected(
          failed.fingerprint.draft,
        )
      )
        return false;
      if (entry && !retireChatSubmission(accountId, submissionId, bindEpoch)) return false;
      forget(submissionId);
      return true;
    },
    [accountId, threadId, bindEpoch, forget],
  );

  return { recovered, rejected, check, retire, markRejected, retry, edit, replaySubmission };
}
