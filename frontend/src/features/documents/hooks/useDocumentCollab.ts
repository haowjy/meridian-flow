import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Extension } from "@codemirror/state";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import {
  buildEditedHunkUpdate,
  buildPartialUpdate,
  buildProposalAcceptCommand,
  buildProposalRejectCommand,
  buildProposalRequestUpdateCommand,
  createProposalManager,
  createProposalReviewRuntime,
  isProposalGroupAcceptResultEvent,
  isProposalNewEvent,
  isProposalSnapshotEvent,
  isProposalStatusChangedEvent,
  isProposalUpdateDataEvent,
  type CollabSyncRuntime,
  type Proposal,
  type ProposalGroupAcceptResultEvent,
  type ProposalOperationsModel,
  type ReviewHunk,
} from "@/core/cm6-collab";
import { makeLogger } from "@/core/lib/logger";
import {
  cacheProposalUpdate,
  deleteCachedProposalUpdate,
  getCachedUpdatesForDocument,
  pruneStaleProposalUpdates,
} from "@/core/lib/proposalCache";
import {
  EMPTY_DOCUMENT_PROPOSAL_STATE,
  useCollabStore,
  type CollabConnectionState,
} from "../stores/useCollabStore";
import { useProjectCollabContext } from "../contexts/ProjectCollabContext";
import type { ProjectCollabDocumentTextEvent } from "./useProjectCollab";

const log = makeLogger("use-document-collab");

interface UseDocumentCollabOptions {
  documentId: string;
  enabled: boolean;
  initialContent: string;
}

interface UseDocumentCollabResult {
  extensions: Extension[];
  connectionState: CollabConnectionState;
  proposals: Map<string, Proposal>;
  operationsModels: Map<string, ProposalOperationsModel>;
  lastGroupAcceptResult: ProposalGroupAcceptResultEvent | null;
  sendProposalAccept: (proposalId: string, idempotencyKey: string) => boolean;
  sendProposalReject: (proposalId: string) => boolean;
  /**
   * Apply a single hunk's edit to the live Y.Doc.
   * Used by partial hunk accept: builds a Yjs update for the hunk's text change
   * and applies it to the document. The collab system automatically broadcasts
   * the update to other clients.
   * Returns { ok: true } on success, { ok: false } if runtime not ready.
   */
  applyHunkUpdate: (
    hunk: ReviewHunk,
    editedInsertedText?: string,
  ) => { ok: boolean };
  /**
   * Request the server to send the yjsUpdate for a specific proposal.
   * Used to lazy-fetch update data for proposals loaded via snapshot
   * (which intentionally omits yjsUpdate for bandwidth optimization).
   */
  requestProposalUpdate: (proposalId: string) => boolean;
  isReady: boolean;
  /** Current Yjs text content — use as initialContent for CodeMirror to avoid
   *  flash of empty placeholder. Safe because ySync only applies future deltas,
   *  so the editor doc must match ytext at mount time. */
  getYtextContent: () => string;
  /** True once IndexedDB cache has loaded into ytext. Editor can show
   *  read-only content before WS connects. */
  idbSynced: boolean;
}

const EMPTY_OPERATIONS_MODELS = new Map<string, ProposalOperationsModel>();

export function useDocumentCollab({
  documentId,
  enabled,
  initialContent: _initialContent,
}: UseDocumentCollabOptions): UseDocumentCollabResult {
  void _initialContent;

  const setState = useCollabStore((s) => s.setState);
  const setStateFromSessionStatus = useCollabStore(
    (s) => s.setStateFromSessionStatus,
  );
  const setProposalState = useCollabStore((s) => s.setProposalState);
  const clearState = useCollabStore((s) => s.clearState);
  const connectionState = useCollabStore(
    (s) => s.stateByDocumentId[documentId] ?? "disconnected",
  );
  const proposalState = useCollabStore(
    (s) =>
      s.proposalStateByDocumentId[documentId] ?? EMPTY_DOCUMENT_PROPOSAL_STATE,
  );

  const { projectCollab, documentSessionManager } = useProjectCollabContext();

  const persistenceRef = useRef<IndexeddbPersistence | null>(null);
  const runtimeRef = useRef<CollabSyncRuntime | null>(null);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  // True once IndexedDB persistence has loaded cached Yjs state into ytext.
  // At this point ytext has content (if any was cached) and the editor can
  // render read-only while waiting for WS connection.
  const [idbSynced, setIdbSynced] = useState(false);
  const [reviewRuntime, setReviewRuntime] = useState<ReturnType<
    typeof createProposalReviewRuntime
  > | null>(null);
  const [reviewRevision, setReviewRevision] = useState(0);
  const pendingRejectsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) {
      setState(documentId, "disconnected");
      return () => {
        clearState(documentId);
      };
    }

    let isStopped = false;
    let runtime: CollabSyncRuntime | null = null;
    let hasHandledInitialConnected = false;
    const proposalManager = createProposalManager({
      onStateChange: (state) => {
        setProposalState(documentId, state);
      },
    });
    // Monotonic counter to guard async snapshot prune against races with
    // newer proposal events (e.g. proposal:new arriving during prune).
    let snapshotSeq = 0;
    const pendingRejects = pendingRejectsRef.current;

    let isIdbLoaded = false;

    // Destroy IDB persistence — server state is authoritative once initial sync completes.
    const cancelIdb = () => {
      if (isIdbLoaded) return;
      isIdbLoaded = true;
      if (persistenceRef.current) {
        void persistenceRef.current.destroy();
        persistenceRef.current = null;
      }
      if (!isStopped) setIdbSynced(true);
    };

    const flushPendingRejects = () => {
      if (!projectCollab.isConnected() || pendingRejects.size === 0) {
        return;
      }

      let flushed = 0;
      for (const proposalId of pendingRejects) {
        projectCollab.sendDocumentCommand(
          documentId,
          buildProposalRejectCommand({
            documentId,
            proposalId,
          }) as unknown as Record<string, unknown>,
        );

        // sendDocumentCommand has no explicit ack; if transport is connected,
        // this is best-effort fire-and-forget.
        pendingRejects.delete(proposalId);
        flushed += 1;
      }

      if (flushed > 0) {
        log.info("flushed pending proposal rejects", {
          flushed,
          remaining: pendingRejects.size,
        });
      }
    };

    const session = documentSessionManager.acquire(documentId);
    runtimeRef.current = runtime = session.runtime;

    const proposalReviewRuntime = createProposalReviewRuntime({
      ydoc: runtime.ydoc,
    });
    setReviewRuntime(proposalReviewRuntime);

    // Use ytext.observe instead of ydoc.on("update") — review derivation
    // only depends on text content, so we avoid spurious recomputes from
    // unrelated Y.Doc changes (e.g. shared-type metadata, map updates).
    const handleTextChange = () => {
      // Skip revision bump when no proposals exist — avoids expensive
      // operationsModels recompute during normal typing without proposals.
      if (proposalManager.hasProposals()) {
        setReviewRevision((current) => current + 1);
      }
    };
    runtime.ytext.observe(handleTextChange);

    setExtensions(runtime.extensions);

    const unregisterStatus = documentSessionManager.onStatusChange(
      documentId,
      (status) => {
        setStateFromSessionStatus(documentId, status);

        if (status === "connected") {
          if (!hasHandledInitialConnected) {
            hasHandledInitialConnected = true;
            cancelIdb();

            // Recreate IDB after initial sync so new edits continue to cache.
            if (!isStopped && persistenceRef.current == null && runtime) {
              persistenceRef.current = new IndexeddbPersistence(
                `meridian-collab:${documentId}`,
                runtime.ydoc,
              );
            }
          }

          flushPendingRejects();
          // Re-evaluate derived review models and deferred proposal fetches
          // once the document session is fully connected.
          setReviewRevision((current) => current + 1);
        }
      },
    );

    const isMatchingEventDocument = (eventDocumentId: string): boolean => {
      if (eventDocumentId === documentId) {
        return true;
      }
      return false;
    };

    const onTextEvent = (event: ProjectCollabDocumentTextEvent) => {
      if (isProposalSnapshotEvent(event)) {
        if (!isMatchingEventDocument(event.documentId)) return;
        proposalManager.onProposalSnapshot(event);

        // Merge cached yjsUpdate for proposals that arrived without one
        // (server omits yjsUpdate from snapshot for bandwidth). Fire-and-forget.
        const seq = ++snapshotSeq;
        void (async () => {
          const cached = await getCachedUpdatesForDocument(event.documentId);
          if (isStopped || cached.size === 0) return;

          for (const proposal of event.proposals) {
            if (proposal.yjsUpdate === undefined && cached.has(proposal.id)) {
              proposalManager.onProposalUpdateData({
                type: "proposal:updateData",
                documentId: event.documentId,
                proposalId: proposal.id,
                yjsUpdate: cached.get(proposal.id)!,
              });
            }
          }

          // Only prune if no newer snapshot has arrived while we were awaiting
          // IndexedDB. A stale prune could delete entries cached by a
          // proposal:new that arrived between this snapshot and the prune.
          if (seq === snapshotSeq) {
            const activeIds = new Set(event.proposals.map((p) => p.id));
            void pruneStaleProposalUpdates(event.documentId, activeIds);
          }
        })();
        return;
      }

      if (isProposalNewEvent(event)) {
        if (!isMatchingEventDocument(event.proposal.documentId)) return;
        proposalManager.onProposalNew(event);
        if (event.proposal.yjsUpdate !== undefined) {
          void cacheProposalUpdate(
            event.proposal.id,
            event.proposal.documentId,
            event.proposal.yjsUpdate,
          );
        }
        return;
      }

      if (isProposalStatusChangedEvent(event)) {
        if (!isMatchingEventDocument(event.documentId)) return;
        proposalManager.onProposalStatusChanged(event);
        if (event.status === "accepted" || event.status === "rejected") {
          void deleteCachedProposalUpdate(event.proposalId);
        }
        return;
      }

      if (isProposalGroupAcceptResultEvent(event)) {
        if (!isMatchingEventDocument(event.documentId)) return;
        proposalManager.onProposalGroupAcceptResult(event);
        return;
      }

      if (isProposalUpdateDataEvent(event)) {
        if (!isMatchingEventDocument(event.documentId)) return;
        proposalManager.onProposalUpdateData(event);
        void cacheProposalUpdate(
          event.proposalId,
          event.documentId,
          event.yjsUpdate,
        );
        setReviewRevision((current) => current + 1);
      }
    };

    const unregisterListener = projectCollab.registerDocumentListener(documentId, {
      onTextEvent,
    });

    // Create IDB persistence immediately so cached content can render while WS sync runs.
    persistenceRef.current = new IndexeddbPersistence(
      `meridian-collab:${documentId}`,
      runtime.ydoc,
    );

    // IDB timeout: if whenSynced never resolves (corruption/quota), unblock
    // loading after 3s so the editor isn't stuck forever.
    const idbTimeout = setTimeout(() => {
      if (isStopped || isIdbLoaded) return;
      log.warn("collab indexeddb load timed out, proceeding without cache", {
        documentId,
      });
      cancelIdb();
    }, 3000);

    const bootstrapPersistence = persistenceRef.current;
    bootstrapPersistence.whenSynced
      .catch((err: unknown) => {
        log.warn("collab indexeddb bootstrap failed", {
          documentId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        clearTimeout(idbTimeout);
        if (isStopped || isIdbLoaded) return;
        isIdbLoaded = true;
        if (!isStopped) setIdbSynced(true);
      });

    const flushTimer = setInterval(flushPendingRejects, 1000);

    return () => {
      isStopped = true;
      clearTimeout(idbTimeout);
      clearInterval(flushTimer);

      unregisterStatus();
      unregisterListener();
      documentSessionManager.release(documentId);

      void persistenceRef.current?.destroy();
      persistenceRef.current = null;

      runtime?.ytext.unobserve(handleTextChange);
      setReviewRuntime(null);
      runtimeRef.current = null;
      pendingRejects.clear();
      setExtensions([]);
      setIdbSynced(false);
      clearState(documentId);
    };
  }, [
    clearState,
    documentId,
    documentSessionManager,
    enabled,
    projectCollab,
    setProposalState,
    setState,
    setStateFromSessionStatus,
  ]);

  // Phase 5: setLocalAwarenessState() for multi-user cursors / presence.
  // The runtime already creates an awareness instance; this hook will expose
  // setLocalUser({ name, color }) and return a peer list for cursor rendering.

  const sendProposalAccept = useCallback(
    (proposalId: string, idempotencyKey: string): boolean => {
      if (!projectCollab.isConnected()) {
        return false;
      }

      projectCollab.sendDocumentCommand(
        documentId,
        buildProposalAcceptCommand({
          documentId,
          proposalId,
          idempotencyKey,
        }) as unknown as Record<string, unknown>,
      );
      return true;
    },
    [documentId, projectCollab],
  );

  const requestProposalUpdate = useCallback(
    (proposalId: string): boolean => {
      if (!projectCollab.isConnected()) {
        return false;
      }

      projectCollab.sendDocumentCommand(
        documentId,
        buildProposalRequestUpdateCommand({
          documentId,
          proposalId,
        }) as unknown as Record<string, unknown>,
      );
      return true;
    },
    [documentId, projectCollab],
  );

  const sendProposalReject = useCallback(
    (proposalId: string): boolean => {
      if (!projectCollab.isConnected()) {
        pendingRejectsRef.current.add(proposalId);
        return false;
      }

      projectCollab.sendDocumentCommand(
        documentId,
        buildProposalRejectCommand({
          documentId,
          proposalId,
        }) as unknown as Record<string, unknown>,
      );
      return true;
    },
    [documentId, projectCollab],
  );

  const operationsModels = useMemo(() => {
    if (!enabled || !reviewRuntime) return EMPTY_OPERATIONS_MODELS;
    void reviewRevision; // recompute trigger
    // Skip derivation when no proposals exist — avoids expensive
    // clone+apply+normalize passes during normal typing.
    if (proposalState.proposals.size === 0) return EMPTY_OPERATIONS_MODELS;
    const result = new Map<string, ProposalOperationsModel>();
    for (const proposal of proposalState.proposals.values()) {
      result.set(proposal.id, reviewRuntime.deriveProposalOperations(proposal));
    }
    return result;
  }, [enabled, proposalState.proposals, reviewRevision, reviewRuntime]);

  const applyHunkUpdate = useCallback(
    (hunk: ReviewHunk, editedInsertedText?: string): { ok: boolean } => {
      const doc = runtimeRef.current?.ydoc;
      if (doc == null) {
        log.warn("applyHunkUpdate called but runtime not ready");
        return { ok: false };
      }
      const update =
        editedInsertedText === undefined
          ? buildPartialUpdate(doc, hunk)
          : buildEditedHunkUpdate(doc, hunk, editedInsertedText);
      Y.applyUpdate(doc, update);
      return { ok: true };
    },
    [],
  );

  return {
    extensions: enabled ? extensions : [],
    connectionState,
    proposals: proposalState.proposals,
    operationsModels,
    lastGroupAcceptResult: proposalState.lastGroupAcceptResult,
    sendProposalAccept,
    sendProposalReject,
    requestProposalUpdate,
    applyHunkUpdate,
    isReady: !enabled || extensions.length > 0,
    idbSynced,
    getYtextContent: useCallback(
      () => runtimeRef.current?.ytext.toString() ?? "",
      [],
    ),
  };
}
