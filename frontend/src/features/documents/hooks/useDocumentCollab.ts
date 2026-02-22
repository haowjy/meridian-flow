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
  createCollabSyncRuntime,
  createProposalManager,
  createProposalReviewRuntime,
  isProposalGroupAcceptResultEvent,
  isProposalNewEvent,
  isProposalSnapshotEvent,
  isProposalStatusChangedEvent,
  isProposalUpdateDataEvent,
  type Proposal,
  type ProposalGroupAcceptResultEvent,
  type ProposalOperationsModel,
  type ReviewHunk,
  toUint8Array,
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
import { createDocumentSubscriptionDebounce } from "./documentSubscriptionDebounce";
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
  const setProposalState = useCollabStore((s) => s.setProposalState);
  const clearState = useCollabStore((s) => s.clearState);
  const connectionState = useCollabStore(
    (s) => s.stateByDocumentId[documentId] ?? "disconnected",
  );
  const proposalState = useCollabStore(
    (s) =>
      s.proposalStateByDocumentId[documentId] ?? EMPTY_DOCUMENT_PROPOSAL_STATE,
  );

  const projectCollab = useProjectCollabContext();

  const persistenceRef = useRef<IndexeddbPersistence | null>(null);
  const runtimeRef = useRef<ReturnType<typeof createCollabSyncRuntime> | null>(
    null,
  );
  // Keep debounce state stable across effect cleanup/re-run (React StrictMode)
  // so a pending unsubscribe can be canceled by the next subscribe call.
  const subscriptionDebounceRef = useRef<ReturnType<
    typeof createDocumentSubscriptionDebounce
  > | null>(null);
  if (subscriptionDebounceRef.current == null) {
    subscriptionDebounceRef.current = createDocumentSubscriptionDebounce();
  }
  const [extensions, setExtensions] = useState<Extension[]>([]);
  // True once IndexedDB persistence has loaded cached Yjs state into ytext.
  // At this point ytext has content (if any was cached) and the editor can
  // render read-only while waiting for WS connection.
  const [idbSynced, setIdbSynced] = useState(false);
  const [reviewRuntime, setReviewRuntime] = useState<ReturnType<
    typeof createProposalReviewRuntime
  > | null>(null);
  const [reviewRevision, setReviewRevision] = useState(0);
  // Queued reject commands that failed because WS wasn't subscribed yet.
  // Flushed on doc:subscribed — same principle as Yjs buffering offline updates.
  const pendingRejectsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) {
      setState(documentId, "disconnected");
      // Clean up stale state from a previously-enabled document when collab is
      // disabled (e.g., switching from .md to .json). Without this, the old
      // document's state leaks in the store until the component fully unmounts.
      return () => {
        clearState(documentId);
      };
    }

    let isStopped = false;
    let runtime: ReturnType<typeof createCollabSyncRuntime> | null = null;
    const proposalManager = createProposalManager({
      onStateChange: (state) => {
        setProposalState(documentId, state);
      },
    });
    // Monotonic counter to guard async snapshot prune against races with
    // newer proposal events (e.g. proposal:new arriving during prune).
    let snapshotSeq = 0;

    const debounce = subscriptionDebounceRef.current!;

    let isIdbLoaded = false;

    // Destroy IDB persistence — server state is authoritative once initial sync completes.
    const cancelIdb = () => {
      if (isIdbLoaded) return;
      isIdbLoaded = true;
      if (persistenceRef.current) {
        persistenceRef.current.destroy();
        persistenceRef.current = null;
      }
      if (!isStopped) setIdbSynced(true);
    };

    runtimeRef.current = runtime = createCollabSyncRuntime({
      documentId,
      sendBinary: (frame) => {
        projectCollab.sendDocumentBinary(documentId, frame);
      },
      onStatusChange: (status) => {
        setState(documentId, status);
      },
      onInitialSyncComplete: () => {
        // Initial server diff is applied — server state is now authoritative.
        cancelIdb();

        // If WS won the race (cancelIdb destroyed persistence), recreate IDB
        // so ongoing edits are cached for future offline access.
        if (!isStopped && persistenceRef.current == null && runtime) {
          persistenceRef.current = new IndexeddbPersistence(
            `meridian-collab:${documentId}`,
            runtime.ydoc,
          );
        }
      },
    });

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

    const isMatchingEventDocument = (eventDocumentId: string): boolean => {
      if (eventDocumentId === documentId) {
        return true;
      }
      return false;
    };

    // Document listener for text events from the project transport
    const onTextEvent = (event: ProjectCollabDocumentTextEvent) => {
      if (event.type === "doc:subscribed") {
        // Handshake completion — start sync
        runtime!.startSync();
        // Flush any reject commands that were queued while offline/pre-subscribe.
        // Same principle as Yjs buffering offline doc updates.
        if (pendingRejectsRef.current.size > 0) {
          let flushed = 0;
          for (const proposalId of pendingRejectsRef.current) {
            const sent = projectCollab.sendDocumentCommand(
              documentId,
              buildProposalRejectCommand({
                documentId,
                proposalId,
              }) as unknown as Record<string, unknown>,
            );
            if (sent) {
              pendingRejectsRef.current.delete(proposalId);
              flushed++;
            }
          }
          if (flushed > 0) {
            log.info("Flushed pending proposal rejects on subscribe", {
              flushed,
              remaining: pendingRejectsRef.current.size,
            });
          }
        }
        // Bump reviewRevision so the auto-request effect in useInlineReview
        // re-evaluates. Proposals loaded from snapshot before subscription was
        // confirmed couldn't send yjsUpdate requests (gate returned false).
        // Now that subscription is confirmed, the re-run will succeed.
        setReviewRevision((current) => current + 1);
        return;
      }

      if (event.type === "doc:unsubscribed") {
        // Document-scoped disconnection; do NOT tear down project transport
        setState(documentId, "disconnected");
        log.info("document unsubscribed via project transport", {
          documentId,
          reason: event.reason,
        });
        return;
      }

      if (event.type === "doc:error") {
        // Document-scoped error; do NOT tear down project transport
        log.warn("document-scoped collab error", {
          documentId,
          code: event.code,
          message: event.message,
        });
        return;
      }

      // Proposal events
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
              // No reviewRevision bump needed — onProposalUpdateData triggers
              // emit() which creates a new Map identity for proposalState.proposals,
              // already a dependency of operationsModels useMemo.
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
        // Cache yjsUpdate if the new proposal includes it
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
        // Remove cache entry when proposal is resolved
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
        // Cache the yjsUpdate for instant re-open (fire-and-forget)
        void cacheProposalUpdate(
          event.proposalId,
          event.documentId,
          event.yjsUpdate,
        );
        // Bump review revision so operationsModels recompute with the new yjsUpdate
        setReviewRevision((current) => current + 1);
      }
    };

    // Binary frame listener — isolated error handling per document
    const onBinaryFrame = (frame: Uint8Array) => {
      try {
        runtime!.handleBinaryFrame(toUint8Array(frame));
      } catch (err) {
        // Document-scoped error: log but do NOT tear down project transport
        log.warn("failed to handle collab binary frame", {
          documentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const startSubscription = () => {
      if (isStopped) return;

      setState(documentId, "syncing");

      // Cancel any pending debounced unsubscribe for this document
      debounce.subscribe(documentId);

      projectCollab.subscribeDocument(documentId);
    };

    // Create IDB persistence BEFORE registering listeners so that
    // persistenceRef.current exists if WS connects very fast (cleanup-007).
    persistenceRef.current = new IndexeddbPersistence(
      `meridian-collab:${documentId}`,
      runtime.ydoc,
    );

    // Register listener before subscribing so we don't miss the doc:subscribed event
    const unregisterListener = projectCollab.registerDocumentListener(
      documentId,
      { onTextEvent, onBinaryFrame },
    );

    // Start WS subscription immediately (in parallel with IDB load).
    startSubscription();

    // IDB timeout: if whenSynced never resolves (corruption/quota), unblock
    // loading after 3s so the editor isn't stuck forever (cleanup-006).
    const idbTimeout = setTimeout(() => {
      if (isStopped || isIdbLoaded) return;
      log.warn("collab indexeddb load timed out, proceeding without cache", {
        documentId,
      });
      cancelIdb();
    }, 3000);

    persistenceRef.current.whenSynced
      .catch((err: unknown) => {
        log.warn("collab indexeddb bootstrap failed", {
          documentId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        clearTimeout(idbTimeout);
        if (isStopped || isIdbLoaded) return; // WS may have already won the race
        isIdbLoaded = true;
        if (!isStopped) setIdbSynced(true);
      });

    const pendingRejects = pendingRejectsRef.current;

    return () => {
      isStopped = true;
      clearTimeout(idbTimeout);

      unregisterListener();

      // Debounced unsubscribe: wait 100ms before actually unsubscribing.
      // If the same document re-mounts (StrictMode), the new effect's
      // debounce.subscribe() call will cancel this pending unsubscribe.
      debounce.scheduleUnsubscribe(documentId, () => {
        projectCollab.unsubscribeDocument(documentId);
      });

      void persistenceRef.current?.destroy();
      persistenceRef.current = null;

      runtime!.ytext.unobserve(handleTextChange);
      setReviewRuntime(null);
      runtime!.destroy();
      runtimeRef.current = null;
      pendingRejects.clear();
      setExtensions([]);
      setIdbSynced(false);
      clearState(documentId);
    };
  }, [
    clearState,
    documentId,
    enabled,
    projectCollab,
    setProposalState,
    setState,
  ]);

  // Phase 5: setLocalAwarenessState() for multi-user cursors / presence.
  // The runtime already creates an awareness instance; this hook will expose
  // setLocalUser({ name, color }) and return a peer list for cursor rendering.

  const sendProposalAccept = useCallback(
    (proposalId: string, idempotencyKey: string): boolean => {
      return projectCollab.sendDocumentCommand(
        documentId,
        buildProposalAcceptCommand({
          documentId,
          proposalId,
          idempotencyKey,
        }) as unknown as Record<string, unknown>,
      );
    },
    [documentId, projectCollab],
  );

  const requestProposalUpdate = useCallback(
    (proposalId: string): boolean => {
      return projectCollab.sendDocumentCommand(
        documentId,
        buildProposalRequestUpdateCommand({
          documentId,
          proposalId,
        }) as unknown as Record<string, unknown>,
      );
    },
    [documentId, projectCollab],
  );

  const sendProposalReject = useCallback(
    (proposalId: string): boolean => {
      const sent = projectCollab.sendDocumentCommand(
        documentId,
        buildProposalRejectCommand({
          documentId,
          proposalId,
        }) as unknown as Record<string, unknown>,
      );
      if (!sent) {
        // Queue for flush on doc:subscribed — same as Yjs buffering offline updates.
        pendingRejectsRef.current.add(proposalId);
      }
      return sent;
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
