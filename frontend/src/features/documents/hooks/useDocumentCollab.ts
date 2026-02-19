import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Extension } from "@codemirror/state";
import { IndexeddbPersistence } from "y-indexeddb";
import {
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
  type ProposalReviewModel,
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
  lastGroupAcceptResult: ProposalGroupAcceptResultEvent | null;
  getProposalReviewModel: (proposalId: string) => ProposalReviewModel | null;
  sendProposalAccept: (proposalId: string, idempotencyKey: string) => boolean;
  sendProposalReject: (proposalId: string) => boolean;
  isReady: boolean;
}

const EMPTY_REVIEW_MODELS = new Map<string, ProposalReviewModel>();

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
    (s) => s.proposalStateByDocumentId[documentId] ?? EMPTY_DOCUMENT_PROPOSAL_STATE,
  );

  const projectCollab = useProjectCollabContext();

  const persistenceRef = useRef<IndexeddbPersistence | null>(null);
  // Keep debounce state stable across effect cleanup/re-run (React StrictMode)
  // so a pending unsubscribe can be canceled by the next subscribe call.
  const subscriptionDebounceRef = useRef<
    ReturnType<typeof createDocumentSubscriptionDebounce> | null
  >(null);
  if (subscriptionDebounceRef.current == null) {
    subscriptionDebounceRef.current = createDocumentSubscriptionDebounce();
  }
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [reviewRuntime, setReviewRuntime] = useState<
    ReturnType<typeof createProposalReviewRuntime> | null
  >(null);
  const [reviewRevision, setReviewRevision] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setState(documentId, "disconnected");
      return;
    }

    let isStopped = false;
    let didBootstrap = false;
    let runtime:
      | ReturnType<typeof createCollabSyncRuntime>
      | null = null;
    const proposalManager = createProposalManager({
      onStateChange: (state) => {
        setProposalState(documentId, state);
      },
    });

    const debounce = subscriptionDebounceRef.current!;

    runtime = createCollabSyncRuntime({
      documentId,
      sendBinary: (frame) => {
        projectCollab.sendDocumentBinary(documentId, frame);
      },
      onStatusChange: (status) => {
        setState(documentId, status);
        if (
          status === "connected" &&
          !didBootstrap &&
          runtime &&
          initialContent.length > 0
        ) {
          didBootstrap = runtime.bootstrapTextIfEmpty(initialContent);
        }
      },
    });

    const proposalReviewRuntime = createProposalReviewRuntime({
      ydoc: runtime.ydoc,
    });
    // Intentional: the review runtime is created alongside the Yjs runtime
    // and must be available for the reviewModels memo on the first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
        if (!isMatchingEventDocument(event.proposal.documentId, event.type)) return;
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

    // Register listener before subscribing so we don't miss the doc:subscribed event
    const unregisterListener = projectCollab.registerDocumentListener(
      documentId,
      { onTextEvent, onBinaryFrame },
    );

    persistenceRef.current = new IndexeddbPersistence(
      `meridian-collab:${documentId}`,
      runtime.ydoc,
    );

    // Wait for IndexedDB to load before subscribing via project transport.
    // This ensures bootstrapTextIfEmpty correctly sees existing IndexedDB content
    // and skips insertion, preventing duplication from the IDB+WS bootstrap race.
    persistenceRef.current.whenSynced
      .catch((err: unknown) => {
        log.warn("collab indexeddb bootstrap failed", {
          documentId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        startSubscription();
      });

    return () => {
      isStopped = true;

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
      setExtensions([]);
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

    return reviewRuntime.deriveProposalReviews(proposalState.proposals.values()).reviews;
  }, [enabled, proposalState.proposals, reviewRevision, reviewRuntime]);

  const getProposalReviewModel = useCallback(
    (proposalId: string): ProposalReviewModel | null => {
      return reviewModels.get(proposalId) ?? null;
    },
    [reviewModels],
  );

  return {
    extensions: enabled ? extensions : [],
    connectionState,
    proposals: proposalState.proposals,
    reviewModels,
    lastGroupAcceptResult: proposalState.lastGroupAcceptResult,
    getProposalReviewModel,
    sendProposalAccept,
    sendProposalReject,
    isReady: !enabled || extensions.length > 0,
  };
}
