import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Extension } from "@codemirror/state";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import {
  buildPartialUpdate,
  buildProposalAcceptCommand,
  buildProposalRejectCommand,
  createCollabSyncRuntime,
  createProposalManager,
  createProposalReviewRuntime,
  isProposalGroupAcceptResultEvent,
  isProposalNewEvent,
  isProposalSnapshotEvent,
  isProposalStatusChangedEvent,
  type Proposal,
  type ProposalGroupAcceptResultEvent,
  type ProposalOperationsModel,
  type ProposalReviewModel,
  type ReviewChunk,
  toUint8Array,
} from "@meridian/cm6-collab";

import { makeLogger } from "@/core/lib/logger";
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
  reviewModels: Map<string, ProposalReviewModel>;
  operationsModels: Map<string, ProposalOperationsModel>;
  lastGroupAcceptResult: ProposalGroupAcceptResultEvent | null;
  sendProposalAccept: (proposalId: string, idempotencyKey: string) => boolean;
  sendProposalReject: (proposalId: string) => boolean;
  /**
   * Apply a single chunk's edit to the live Y.Doc.
   * Used by partial chunk accept: builds a Yjs update for the chunk's text change
   * and applies it to the document. The collab system automatically broadcasts
   * the update to other clients.
   */
  applyChunkUpdate: (chunk: ReviewChunk) => void;
  isReady: boolean;
  /** Current Yjs text content — use as initialContent for CodeMirror to avoid
   *  flash of empty placeholder. Safe because ySync only applies future deltas,
   *  so the editor doc must match ytext at mount time. */
  getYtextContent: () => string;
  /** True once IndexedDB cache has loaded into ytext. Editor can show
   *  read-only content before WS connects. */
  idbSynced: boolean;
}

const EMPTY_REVIEW_MODELS = new Map<string, ProposalReviewModel>();
const EMPTY_OPERATIONS_MODELS = new Map<string, ProposalOperationsModel>();

export function useDocumentCollab({
  documentId,
  enabled,
  initialContent,
}: UseDocumentCollabOptions): UseDocumentCollabResult {
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
    let didBootstrap = false;
    let runtime: ReturnType<typeof createCollabSyncRuntime> | null = null;
    const proposalManager = createProposalManager({
      onStateChange: (state) => {
        setProposalState(documentId, state);
      },
    });

    const debounce = subscriptionDebounceRef.current!;

    let isIdbLoaded = false;
    let isInitialSyncDone = false;

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

    // Bootstrap seed content only after initial sync completes (SyncStep2 processed,
    // server state is in ytext). If IDB loaded first, ytext already has cached
    // content and bootstrap will skip (ytext.length > 0). If WS won, IDB is
    // cancelled above.
    const tryBootstrap = () => {
      if (didBootstrap || !isInitialSyncDone) return;
      // Initial sync done — server state wins. Cancel any pending IDB load.
      cancelIdb();
      if (!runtime || initialContent.length === 0) return;
      didBootstrap = runtime.bootstrapTextIfEmpty(initialContent);
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
        isInitialSyncDone = true;
        tryBootstrap();

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
    // Intentional: the review runtime is created alongside the Yjs runtime
    // and must be available for the reviewModels memo on the first render.
    setReviewRuntime(proposalReviewRuntime);
    const handleDocUpdate = () => {
      setReviewRevision((current) => current + 1);
    };
    runtime.ydoc.on("update", handleDocUpdate);

    setExtensions(runtime.extensions);

    const isMatchingEventDocument = (
      eventDocumentId: string,
      eventType: string,
    ): boolean => {
      if (eventDocumentId === documentId) {
        return true;
      }
      log.debug("ignoring collab proposal event for different document", {
        type: eventType,
        expectedDocumentId: documentId,
        eventDocumentId,
      });
      return false;
    };

    // Document listener for text events from the project transport
    const onTextEvent = (event: ProjectCollabDocumentTextEvent) => {
      if (event.type === "doc:subscribed") {
        // Handshake completion — start sync
        runtime!.startSync();
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
        if (!isMatchingEventDocument(event.documentId, event.type)) return;
        proposalManager.onProposalSnapshot(event);
        return;
      }

      if (isProposalNewEvent(event)) {
        if (!isMatchingEventDocument(event.proposal.documentId, event.type))
          return;
        proposalManager.onProposalNew(event);
        return;
      }

      if (isProposalStatusChangedEvent(event)) {
        if (!isMatchingEventDocument(event.documentId, event.type)) return;
        proposalManager.onProposalStatusChanged(event);
        return;
      }

      if (isProposalGroupAcceptResultEvent(event)) {
        if (!isMatchingEventDocument(event.documentId, event.type)) return;
        proposalManager.onProposalGroupAcceptResult(event);
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
        tryBootstrap();
      });

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

      runtime!.ydoc.off("update", handleDocUpdate);
      setReviewRuntime(null);
      runtime!.destroy();
      runtimeRef.current = null;
      setExtensions([]);
      setIdbSynced(false);
      clearState(documentId);
    };
  }, [
    clearState,
    documentId,
    enabled,
    initialContent,
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

  const sendProposalReject = useCallback(
    (proposalId: string): boolean => {
      return projectCollab.sendDocumentCommand(
        documentId,
        buildProposalRejectCommand({
          documentId,
          proposalId,
        }) as unknown as Record<string, unknown>,
      );
    },
    [documentId, projectCollab],
  );

  const reviewModels = useMemo(() => {
    if (!enabled) {
      return EMPTY_REVIEW_MODELS;
    }

    if (!reviewRuntime) {
      return EMPTY_REVIEW_MODELS;
    }

    // reviewRevision is the recompute trigger from Yjs updates.
    const revision = reviewRevision;
    void revision;

    return reviewRuntime.deriveProposalReviews(proposalState.proposals.values())
      .reviews;
  }, [enabled, proposalState.proposals, reviewRevision, reviewRuntime]);

  const operationsModels = useMemo(() => {
    if (!enabled || !reviewRuntime) return EMPTY_OPERATIONS_MODELS;
    void reviewRevision; // recompute trigger
    const result = new Map<string, ProposalOperationsModel>();
    for (const proposal of proposalState.proposals.values()) {
      result.set(proposal.id, reviewRuntime.deriveProposalOperations(proposal));
    }
    return result;
  }, [enabled, proposalState.proposals, reviewRevision, reviewRuntime]);

  const applyChunkUpdate = useCallback((chunk: ReviewChunk) => {
    const doc = runtimeRef.current?.ydoc;
    if (doc == null) {
      log.warn("applyChunkUpdate called but runtime not ready");
      return;
    }
    const update = buildPartialUpdate(doc, chunk);
    Y.applyUpdate(doc, update);
  }, []);

  return {
    extensions: enabled ? extensions : [],
    connectionState,
    proposals: proposalState.proposals,
    reviewModels,
    operationsModels,
    lastGroupAcceptResult: proposalState.lastGroupAcceptResult,
    sendProposalAccept,
    sendProposalReject,
    applyChunkUpdate,
    isReady: !enabled || extensions.length > 0,
    idbSynced,
    getYtextContent: useCallback(
      () => runtimeRef.current?.ytext.toString() ?? "",
      [],
    ),
  };
}
