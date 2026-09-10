/** One Project runtime executor for fresh post-Apply live-readiness attempts. */

import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { listWorkDrafts } from "@/client/api/drafts-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  useContextRemovalCoordinator,
  useProjectDocumentLiveOpener,
} from "../context/account-feature-context";
import { useAcknowledgeLiveBinding } from "../dock/editor-review-handoff";
import {
  useOptionalPostApplyDisposition,
  usePostApplyDispositionOwner,
  usePostApplySnapshot,
} from "./DraftApplyRecoveryProvider";
import type {
  ApplyReservationRef,
  DispositionGrant,
  DraftRecoveryRef,
  PostApplyAttemptGrant,
} from "./draft-apply-recovery-owner";

export type InitialRecoveryOutcome =
  | { kind: "live-ready" }
  | { kind: "awaiting-live" }
  | { kind: "writer-abandoned" };

export type ProjectDraftApplyRecoveryCommands = {
  awaitInitialOutcome(
    recovery: DraftRecoveryRef,
    signal?: AbortSignal,
  ): Promise<InitialRecoveryOutcome>;
  retry(recovery: DraftRecoveryRef): void;
  abandon(recovery: DraftRecoveryRef): void;
  finishDisposition(recovery: DraftRecoveryRef): void;
  checkApplyOutcome(reservation: ApplyReservationRef): void;
  matchingHostMounted(input: { recovery: DraftRecoveryRef; hostGeneration: number }): void;
};

const CommandsContext = createContext<ProjectDraftApplyRecoveryCommands | null>(null);
const EMPTY_POST_APPLY_SNAPSHOT = {
  nextVersion: 1,
  reservations: [],
  items: [],
  appliedSuppressions: [],
  remoteDraftWitnesses: [],
} as const;

export function postApplyHostDemandKey(input: {
  inlineDocumentIds: readonly string[];
  desktopHostDocumentIds: readonly string[];
  mobileHostDocumentId: string | null;
}): string {
  return `${input.inlineDocumentIds.join(",")}:${input.mobileHostDocumentId ?? ""}:${input.desktopHostDocumentIds.join(",")}`;
}

export function postApplyHostRequired(input: {
  documentId: string;
  inlineDocumentIds: readonly string[];
  desktopHostDocumentIds: readonly string[];
  mobileHostDocumentId: string | null;
}): boolean {
  return (
    input.inlineDocumentIds.includes(input.documentId) ||
    input.desktopHostDocumentIds.includes(input.documentId) ||
    input.mobileHostDocumentId === input.documentId
  );
}

export function ProjectDraftApplyRecoveryExecutor({
  projectId,
  scopeKey,
  mobileHostDocumentId,
  inlineDocumentIds,
  desktopHostDocumentIds,
  workLabels,
  children,
}: {
  projectId: string;
  scopeKey: string;
  mobileHostDocumentId: string | null;
  inlineDocumentIds: readonly string[];
  desktopHostDocumentIds: readonly string[];
  workLabels: Readonly<Record<string, string>>;
  children: React.ReactNode;
}) {
  const owner = usePostApplyDispositionOwner();
  const queryClient = useQueryClient();
  const snapshot = usePostApplySnapshot();
  const opener = useProjectDocumentLiveOpener();
  const acknowledge = useAcknowledgeLiveBinding();
  const removal = useContextRemovalCoordinator();
  const running = useRef<{
    grant: PostApplyAttemptGrant;
    abort: AbortController;
    scopeKey: string;
  } | null>(null);
  const consumedDispositionEdges = useRef(new Set<string>());
  const [executorRevision, advanceExecutor] = useState(0);
  const demandKey = postApplyHostDemandKey({
    inlineDocumentIds,
    desktopHostDocumentIds,
    mobileHostDocumentId,
  });
  const demandRevision = useRef({ key: demandKey, revision: 0 });
  if (demandRevision.current.key !== demandKey)
    demandRevision.current = { key: demandKey, revision: demandRevision.current.revision + 1 };

  const currentDemand = useCallback(
    (documentId: string) => ({
      revision: demandRevision.current.revision,
      required: postApplyHostRequired({
        documentId,
        inlineDocumentIds,
        desktopHostDocumentIds,
        mobileHostDocumentId,
      }),
    }),
    [desktopHostDocumentIds, inlineDocumentIds, mobileHostDocumentId],
  );

  const settleContext = useCallback(
    async (disposition: DispositionGrant) => {
      const item = owner.currentItem(disposition.recovery);
      if (item?.phase.kind !== "disposing") return;
      try {
        const receipt = await removal.settleDraftRecovery({
          identity: item.identity,
          entryVersion: item.entryVersion,
          dispositionToken: disposition.dispositionToken,
          disposition: disposition.outcome,
          draftTab: item.obligations.draftTab,
        });
        if (receipt.kind === "stale-obligation") {
          owner.failDisposition({ disposition, failure: "stale-context-obligation" });
          return;
        }
        owner.recordDispositionEffect({ disposition, effect: "context" });
        owner.completeDisposition(disposition);
      } catch {
        owner.failDisposition({ disposition, failure: "effect-failed" });
      }
    },
    [owner, removal],
  );

  const executeDisposition = useCallback(
    (disposition: DispositionGrant) => {
      const edge = `${disposition.recovery.entryVersion}:${disposition.dispositionToken}`;
      if (consumedDispositionEdges.current.has(edge)) return;
      consumedDispositionEdges.current.add(edge);
      void settleContext(disposition);
    },
    [settleContext],
  );

  useEffect(() => {
    const current = running.current;
    if (current && !owner.currentItem(current.grant.recovery)) {
      current.abort.abort();
      running.current = null;
    }
    if (running.current) return;
    const currentDispositionEdges = new Set(
      snapshot.items.flatMap((item) =>
        item.identity.projectId === projectId && item.phase.kind === "disposing"
          ? [`${item.entryVersion}:${item.phase.dispositionToken}`]
          : [],
      ),
    );
    for (const edge of consumedDispositionEdges.current) {
      if (!currentDispositionEdges.has(edge)) consumedDispositionEdges.current.delete(edge);
    }
    const disposing = snapshot.items.find(
      (item) => item.identity.projectId === projectId && item.phase.kind === "disposing",
    );
    if (disposing?.phase.kind === "disposing") {
      executeDisposition({
        recovery: { identity: disposing.identity, entryVersion: disposing.entryVersion },
        dispositionToken: disposing.phase.dispositionToken,
        outcome: disposing.phase.outcome,
      });
      return;
    }
    const queued = snapshot.items.find(
      (item) => item.identity.projectId === projectId && item.phase.kind === "queued",
    );
    if (!queued) return;
    const recovery = { identity: queued.identity, entryVersion: queued.entryVersion };
    const grant = owner.beginAttempt(recovery);
    if (!grant) return;
    const abort = new AbortController();
    running.current = { grant, abort, scopeKey };
    const demandAtOpen = currentDemand(queued.identity.documentId);
    void opener
      .open({
        source: "server",
        projectId: queued.identity.projectId,
        documentId: queued.identity.documentId,
        signal: abort.signal,
      })
      .then(async (opened) => {
        if (opened.kind !== "opened") return "unavailable" as const;
        const routed = await acknowledge(opened.admission, abort.signal);
        if (routed.kind === "acknowledged") return "ready" as const;
        if (routed.kind !== "unclaimed")
          return routed.kind === "unusable" ? ("host-unusable" as const) : ("cancelled" as const);
        const afterClaim = currentDemand(queued.identity.documentId);
        if (
          demandAtOpen.required ||
          afterClaim.required ||
          demandAtOpen.revision !== afterClaim.revision
        )
          return afterClaim.required ? ("host-missing" as const) : ("stale" as const);
        const binding = await opened.admission.bind(
          `post-apply-verifier:${queued.entryVersion}:${grant.attemptVersion}`,
        );
        try {
          await binding.session.waitForCurrentSync(10_000);
          const session = binding.session.getSnapshot();
          if (session.status !== "synced") return "sync-timeout" as const;
          if (session.schemaFence !== null) return "schema-fenced" as const;
          const afterSync = currentDemand(queued.identity.documentId);
          if (afterSync.required || afterSync.revision !== demandAtOpen.revision)
            return afterSync.required ? ("host-missing" as const) : ("stale" as const);
          return "ready" as const;
        } finally {
          binding.release();
        }
      })
      .then((result) => {
        if (result !== "ready") {
          owner.failAttempt({ ...grant, failure: result });
          return;
        }
        const disposition = owner.beginLiveSettlement(grant);
        if (disposition) executeDisposition(disposition);
      })
      .catch(() =>
        owner.failAttempt({
          ...grant,
          failure: abort.signal.aborted ? "cancelled" : "unavailable",
        }),
      )
      .finally(() => {
        if (running.current?.grant === grant) {
          running.current = null;
          advanceExecutor((value) => value + 1);
        }
      });
  }, [
    acknowledge,
    currentDemand,
    executorRevision,
    opener,
    owner,
    projectId,
    scopeKey,
    executeDisposition,
    snapshot.items,
  ]);

  useEffect(
    () => () => {
      const current = running.current;
      if (!current) return;
      current.abort.abort();
      owner.failAttempt({ ...current.grant, failure: "cancelled" });
      running.current = null;
    },
    [owner, projectId],
  );

  useEffect(() => {
    const current = running.current;
    if (!current || current.scopeKey === scopeKey) return;
    current.abort.abort();
    owner.failAttempt({ ...current.grant, failure: "cancelled" });
    running.current = null;
    advanceExecutor((value) => value + 1);
  }, [owner, scopeKey]);

  const commands = useMemo<ProjectDraftApplyRecoveryCommands>(
    () => ({
      awaitInitialOutcome(recovery, signal) {
        return new Promise((resolve) => {
          const inspect = () => {
            const item = owner.currentItem(recovery);
            if (item?.phase.kind === "awaiting-live") return done({ kind: "awaiting-live" });
            if (item?.phase.kind === "disposing" && item.phase.outcome === "writer-abandoned")
              return done({ kind: "writer-abandoned" });
            const suppression = owner
              .getSnapshot()
              .appliedSuppressions.find(
                (candidate) =>
                  candidate.committedVersion === recovery.entryVersion &&
                  candidate.identity.draftId === recovery.identity.draftId,
              );
            if (!item && suppression?.terminalDisposition === "live-ready")
              done({ kind: "live-ready" });
          };
          const stop = owner.subscribe(inspect);
          const abort = () => done({ kind: "awaiting-live" });
          const done = (outcome: InitialRecoveryOutcome) => {
            stop();
            signal?.removeEventListener("abort", abort);
            resolve(outcome);
          };
          signal?.addEventListener("abort", abort, { once: true });
          inspect();
        });
      },
      retry: (recovery) => void owner.requestRetry({ recovery, trigger: "manual" }),
      abandon(recovery) {
        running.current?.abort.abort();
        const disposition = owner.beginAbandonment(recovery);
        if (disposition) executeDisposition(disposition);
      },
      finishDisposition(recovery) {
        const item = owner.currentItem(recovery);
        if (item?.phase.kind !== "disposing") return;
        const disposition = {
          recovery,
          dispositionToken: item.phase.dispositionToken,
          outcome: item.phase.outcome,
        };
        consumedDispositionEdges.current.delete(
          `${recovery.entryVersion}:${item.phase.dispositionToken}`,
        );
        executeDisposition(disposition);
      },
      checkApplyOutcome(reservation) {
        const check = owner.beginApplyOutcomeCheck(reservation);
        if (!check) return;
        void listWorkDrafts(reservation.identity.projectId, reservation.identity.workId)
          .then(({ drafts }) => {
            owner.reconcileForcedDraftList({
              accountId: reservation.identity.accountId,
              projectId: reservation.identity.projectId,
              workId: reservation.identity.workId,
              outcomeCheck: check,
              activeDrafts: drafts.map((draft) => ({
                identity: {
                  ...reservation.identity,
                  documentId: draft.documentId,
                  draftId: draft.draftId,
                },
                presentation: {
                  documentName: draft.documentName,
                  contextPath: draft.contextPath,
                  owningWorkLabel: workLabels[reservation.identity.workId] ?? null,
                },
                obligations: { draftTab: { kind: "none" }, branch: { kind: "none" } },
              })),
            });
            queryClient.setQueryData(
              projectQueryKeys.workDrafts(
                reservation.identity.projectId,
                reservation.identity.workId,
              ),
              drafts,
            );
          })
          .catch(() => undefined);
      },
      matchingHostMounted: ({ recovery }) =>
        void owner.requestRetry({ recovery, trigger: "matching-host-mounted" }),
    }),
    [executeDisposition, owner, queryClient, workLabels],
  );
  return <CommandsContext.Provider value={commands}>{children}</CommandsContext.Provider>;
}

export function useProjectDraftApplyRecovery(): ProjectDraftApplyRecoveryCommands {
  const value = useContext(CommandsContext);
  if (!value) throw new Error("ProjectDraftApplyRecoveryExecutor is required");
  return value;
}

export function useOptionalProjectDraftApplyRecovery(): ProjectDraftApplyRecoveryCommands | null {
  return useContext(CommandsContext);
}

export function usePostApplyHostWake(
  projectId: string,
  documentId: string | null,
  hostGeneration: number,
): void {
  const disposition = useOptionalPostApplyDisposition();
  const commands = useContext(CommandsContext);
  const snapshot = useSyncExternalStore(
    disposition?.owner.subscribe ?? (() => () => undefined),
    disposition?.owner.getSnapshot ?? (() => EMPTY_POST_APPLY_SNAPSHOT),
    disposition?.owner.getSnapshot ?? (() => EMPTY_POST_APPLY_SNAPSHOT),
  );
  const delivered = useRef(new Set<string>());
  useEffect(() => {
    if (!documentId || !commands) return;
    for (const item of snapshot.items) {
      if (
        item.identity.projectId !== projectId ||
        item.identity.documentId !== documentId ||
        item.phase.kind !== "awaiting-live"
      )
        continue;
      const edge = `${hostGeneration}:${item.entryVersion}`;
      if (delivered.current.has(edge)) continue;
      delivered.current.add(edge);
      commands.matchingHostMounted({
        recovery: { identity: item.identity, entryVersion: item.entryVersion },
        hostGeneration,
      });
    }
  }, [commands, documentId, hostGeneration, projectId, snapshot.items]);
}
