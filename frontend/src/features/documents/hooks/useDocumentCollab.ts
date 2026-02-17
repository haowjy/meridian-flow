import { useCallback, useEffect, useRef, useState } from "react";
import type { Extension } from "@codemirror/state";
import { IndexeddbPersistence } from "y-indexeddb";
import {
  buildHeartbeatAckMessage,
  buildProposalAcceptCommand,
  buildProposalRejectCommand,
  createCollabSyncRuntime,
  createProposalManager,
  isProposalGroupAcceptResultEvent,
  isProposalNewEvent,
  isProposalSnapshotEvent,
  isProposalStatusChangedEvent,
  parseCollabServerTextEvent,
  type Proposal,
  type ProposalGroupAcceptResultEvent,
  toUint8Array,
} from "@meridian/cm6-collab";

import { API_BASE_URL } from "@/core/lib/api";
import { makeLogger } from "@/core/lib/logger";
import { createClient } from "@/core/supabase/client";
import {
  EMPTY_DOCUMENT_PROPOSAL_STATE,
  useCollabStore,
  type CollabConnectionState,
} from "../stores/useCollabStore";

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
  lastGroupAcceptResult: ProposalGroupAcceptResultEvent | null;
  sendProposalAccept: (proposalId: string, idempotencyKey: string) => boolean;
  sendProposalReject: (proposalId: string) => boolean;
  isReady: boolean;
}

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

  const websocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const persistenceRef = useRef<IndexeddbPersistence | null>(null);
  const [extensions, setExtensions] = useState<Extension[]>([]);

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

    runtime = createCollabSyncRuntime({
      documentId,
      sendBinary: (frame) => {
        const ws = websocketRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(frame);
        }
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

    setExtensions(runtime.extensions);

    const scheduleReconnect = () => {
      if (isStopped) {
        return;
      }

      const attempt = reconnectAttemptRef.current;
      const baseDelay = Math.min(5000, 250 * 2 ** attempt);
      const jitter = baseDelay * 0.15 * (Math.random() * 2 - 1);
      const delayMs = Math.max(100, Math.round(baseDelay + jitter));
      reconnectAttemptRef.current = attempt + 1;

      reconnectTimerRef.current = window.setTimeout(() => {
        void connect();
      }, delayMs);
    };

    const connect = async () => {
      if (isStopped) {
        return;
      }

      setState(documentId, "syncing");

      const token = await resolveAccessToken();
      if (!token) {
        setState(documentId, "disconnected");
        scheduleReconnect();
        return;
      }

      const ws = new WebSocket(buildDocumentWSURL(documentId));
      ws.binaryType = "arraybuffer";
      websocketRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        ws.send(token);
        runtime.startSync();
      };

      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data === "string") {
          const textEvent = parseCollabServerTextEvent(event.data);
          if (!textEvent) {
            return;
          }

          if (textEvent.type === "heartbeat") {
            ws.send(buildHeartbeatAckMessage());
            return;
          }

          if (textEvent.type === "error") {
            if (textEvent.code === "AUTH_FAILED") {
              // Fire-and-forget: best-effort warm-up so the token is ready
              // by the time the reconnect loop calls resolveAccessToken().
              void createClient().auth.refreshSession();
            }
            ws.close();
            return;
          }

          if (isProposalSnapshotEvent(textEvent)) {
            proposalManager.onProposalSnapshot(textEvent);
            return;
          }

          if (isProposalNewEvent(textEvent)) {
            proposalManager.onProposalNew(textEvent);
            return;
          }

          if (isProposalStatusChangedEvent(textEvent)) {
            proposalManager.onProposalStatusChanged(textEvent);
            return;
          }

          if (isProposalGroupAcceptResultEvent(textEvent)) {
            proposalManager.onProposalGroupAcceptResult(textEvent);
            return;
          }

          return;
        }

        try {
          runtime.handleBinaryFrame(toUint8Array(event.data));
        } catch (err) {
          log.warn("failed to handle collab binary frame, closing to reconnect", {
            documentId,
            error: err instanceof Error ? err.message : String(err),
          });
          ws.close();
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onclose = () => {
        if (websocketRef.current === ws) {
          websocketRef.current = null;
        }

        if (isStopped) {
          return;
        }

        setState(documentId, "disconnected");
        scheduleReconnect();
      };
    };

    persistenceRef.current = new IndexeddbPersistence(
      `meridian-collab:${documentId}`,
      runtime.ydoc,
    );

    void persistenceRef.current.whenSynced.catch((err: unknown) => {
      log.warn("collab indexeddb bootstrap failed", {
        documentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    void connect();

    return () => {
      isStopped = true;

      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      const ws = websocketRef.current;
      websocketRef.current = null;
      if (ws) {
        ws.close();
      }

      void persistenceRef.current?.destroy();
      persistenceRef.current = null;

      runtime.destroy();
      setExtensions([]);
      clearState(documentId);
    };
  }, [
    clearState,
    documentId,
    enabled,
    initialContent,
    setProposalState,
    setState,
  ]);

  // Phase 5: setLocalAwarenessState() for multi-user cursors / presence.
  // The runtime already creates an awareness instance; this hook will expose
  // setLocalUser({ name, color }) and return a peer list for cursor rendering.

  const sendProposalAccept = useCallback(
    (proposalId: string, idempotencyKey: string): boolean => {
      const ws = websocketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      ws.send(
        JSON.stringify(
          buildProposalAcceptCommand({
            proposalId,
            idempotencyKey,
          }),
        ),
      );
      return true;
    },
    [],
  );

  const sendProposalReject = useCallback((proposalId: string): boolean => {
    const ws = websocketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    ws.send(
      JSON.stringify(
        buildProposalRejectCommand({
          proposalId,
        }),
      ),
    );
    return true;
  }, []);

  return {
    extensions: enabled ? extensions : [],
    connectionState,
    proposals: proposalState.proposals,
    lastGroupAcceptResult: proposalState.lastGroupAcceptResult,
    sendProposalAccept,
    sendProposalReject,
    isReady: !enabled || extensions.length > 0,
  };
}

async function resolveAccessToken(): Promise<string | null> {
  const supabase = createClient();

  const current = await supabase.auth.getSession();
  const currentToken = current.data.session?.access_token;
  if (currentToken) {
    return currentToken;
  }

  const refreshed = await supabase.auth.refreshSession();
  return refreshed.data.session?.access_token ?? null;
}

function buildDocumentWSURL(documentId: string): string {
  const base = normalizeAPIBase(API_BASE_URL);
  const url = new URL(`/ws/documents/${documentId}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function normalizeAPIBase(base: string): string {
  if (base.startsWith("http://") || base.startsWith("https://")) {
    return base;
  }

  return `http://${base}`;
}
