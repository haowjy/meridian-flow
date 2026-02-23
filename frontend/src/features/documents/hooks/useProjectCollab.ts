import { useEffect, useMemo } from "react";
import {
  buildHeartbeatAckMessage,
  isProposalGroupAcceptResultEvent,
  isProposalNewEvent,
  isProposalSnapshotEvent,
  isProposalStatusChangedEvent,
  isProposalUpdateDataEvent,
  parseCollabServerTextEvent,
  toUint8Array,
  unwrapEnvelope,
  type ProposalGroupAcceptResultEvent,
  type ProposalNewEvent,
  type ProposalSnapshotEvent,
  type ProposalStatusChangedEvent,
  type ProposalUpdateDataEvent,
} from "@/core/cm6-collab";

import { API_BASE_URL } from "@/core/lib/api";
import { makeLogger } from "@/core/lib/logger";
import { createClient } from "@/core/supabase/client";
import { useTreeStore } from "@/core/stores/useTreeStore";

const log = makeLogger("use-project-collab");
const WS_OPEN = 1;

export interface DocSubscribedEvent {
  type: "doc:subscribed";
  documentId: string;
}

export interface DocUnsubscribedEvent {
  type: "doc:unsubscribed";
  documentId: string;
  reason?: string;
}

export interface DocErrorEvent {
  type: "doc:error";
  documentId: string;
  code: string;
  message: string;
}

export type ProjectCollabControlEvent =
  | DocSubscribedEvent
  | DocUnsubscribedEvent
  | DocErrorEvent;

export type ProjectCollabProposalEvent =
  | ProposalSnapshotEvent
  | ProposalNewEvent
  | ProposalStatusChangedEvent
  | ProposalGroupAcceptResultEvent
  | ProposalUpdateDataEvent;

export type ProjectCollabDocumentTextEvent =
  | ProjectCollabControlEvent
  | ProjectCollabProposalEvent;

export interface ProjectCollabDocumentListener {
  onBinaryFrame?: (frame: Uint8Array) => void;
  onTextEvent?: (event: ProjectCollabDocumentTextEvent) => void;
}

export interface ProjectCollabTransport {
  subscribeDocument: (documentId: string) => void;
  unsubscribeDocument: (documentId: string) => void;
  sendDocumentCommand: (
    documentId: string,
    command: Record<string, unknown>,
  ) => boolean;
  sendDocumentBinary: (documentId: string, frame: Uint8Array) => boolean;
  registerDocumentListener: (
    documentId: string,
    listener: ProjectCollabDocumentListener,
  ) => () => void;
}

export interface ProjectCollabWebSocket {
  readyState: number;
  binaryType: string;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  send: (data: string | ArrayBufferLike | ArrayBufferView) => void;
  close: (code?: number, reason?: string) => void;
}

export interface CreateProjectCollabTransportOptions {
  projectId: string;
  resolveAccessToken?: () => Promise<string | null>;
  refreshSession?: () => Promise<unknown>;
  createWebSocket?: (url: string) => ProjectCollabWebSocket;
  setTimer?: (
    callback: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timerId: ReturnType<typeof setTimeout>) => void;
  random?: () => number;
}

interface ProjectCollabTransportController extends ProjectCollabTransport {
  start: () => void;
  stop: () => void;
}

export function createProjectCollabTransport(
  options: CreateProjectCollabTransportOptions,
): ProjectCollabTransportController {
  const resolveAccessTokenFn = options.resolveAccessToken ?? resolveAccessToken;
  const refreshSessionFn =
    options.refreshSession ?? (() => createClient().auth.refreshSession());
  const createWebSocketFn =
    options.createWebSocket ??
    ((url: string) => new WebSocket(url) as unknown as ProjectCollabWebSocket);
  const setTimerFn = options.setTimer ?? setTimeout;
  const clearTimerFn = options.clearTimer ?? clearTimeout;
  const randomFn = options.random ?? Math.random;

  let websocket: ProjectCollabWebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let isStopped = true;

  const activeSubscriptions = new Set<string>();
  const subscribedDocuments = new Set<string>();
  const pendingBinaryByDocument = new Map<string, Uint8Array[]>();
  const listenersByDocument = new Map<
    string,
    Set<ProjectCollabDocumentListener>
  >();

  const clearReconnectTimer = () => {
    if (reconnectTimer === null) {
      return;
    }

    clearTimerFn(reconnectTimer);
    reconnectTimer = null;
  };

  const getOpenSocket = (): ProjectCollabWebSocket | null => {
    if (websocket == null || websocket.readyState !== WS_OPEN) {
      return null;
    }
    return websocket;
  };

  const notifyDocumentTextListeners = (
    documentId: string,
    event: ProjectCollabDocumentTextEvent,
  ) => {
    const listeners = listenersByDocument.get(documentId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener.onTextEvent?.(event);
    }
  };

  const notifyDocumentBinaryListeners = (
    documentId: string,
    frame: Uint8Array,
  ) => {
    const listeners = listenersByDocument.get(documentId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener.onBinaryFrame?.(frame);
    }
  };

  const flushPendingBinaryFrames = (documentId: string) => {
    const pendingFrames = pendingBinaryByDocument.get(documentId);
    if (!pendingFrames || pendingFrames.length === 0) {
      return;
    }

    pendingBinaryByDocument.delete(documentId);
    for (const frame of pendingFrames) {
      notifyDocumentBinaryListeners(documentId, frame);
    }
  };

  const sendDocSubscribe = (
    documentId: string,
    targetSocket?: ProjectCollabWebSocket,
  ) => {
    const ws = targetSocket ?? getOpenSocket();
    if (ws == null) {
      return;
    }

    ws.send(
      JSON.stringify({
        type: "doc:subscribe",
        documentId,
      }),
    );
  };

  const sendDocUnsubscribe = (documentId: string) => {
    const ws = getOpenSocket();
    if (ws == null) {
      return;
    }

    ws.send(
      JSON.stringify({
        type: "doc:unsubscribe",
        documentId,
      }),
    );
  };

  const replayActiveSubscriptions = (targetSocket: ProjectCollabWebSocket) => {
    subscribedDocuments.clear();

    for (const documentId of activeSubscriptions) {
      pendingBinaryByDocument.set(documentId, []);
      sendDocSubscribe(documentId, targetSocket);
    }
  };

  const scheduleReconnect = () => {
    if (isStopped) {
      return;
    }

    clearReconnectTimer();

    const attempt = reconnectAttempt;
    const baseDelay = Math.min(5000, 250 * 2 ** attempt);
    const jitter = baseDelay * 0.15 * (randomFn() * 2 - 1);
    const delayMs = Math.max(100, Math.round(baseDelay + jitter));

    reconnectAttempt = attempt + 1;
    reconnectTimer = setTimerFn(() => {
      void connect();
    }, delayMs);
  };

  const handleDocSubscribed = (event: DocSubscribedEvent) => {
    const documentId = normalizeDocumentId(event.documentId);
    if (!documentId || !activeSubscriptions.has(documentId)) {
      return;
    }

    pendingBinaryByDocument.set(
      documentId,
      pendingBinaryByDocument.get(documentId) ?? [],
    );
    subscribedDocuments.add(documentId);

    notifyDocumentTextListeners(documentId, {
      ...event,
      documentId,
    });
    flushPendingBinaryFrames(documentId);
  };

  const handleDocUnsubscribed = (event: DocUnsubscribedEvent) => {
    const documentId = normalizeDocumentId(event.documentId);
    if (!documentId) {
      return;
    }

    activeSubscriptions.delete(documentId);
    subscribedDocuments.delete(documentId);
    pendingBinaryByDocument.delete(documentId);

    notifyDocumentTextListeners(documentId, {
      ...event,
      documentId,
    });
  };

  const handleDocError = (event: DocErrorEvent) => {
    const documentId = normalizeDocumentId(event.documentId);
    if (!documentId) {
      return;
    }

    if (event.code === "DOCUMENT_NOT_FOUND") {
      log.warn("project collab document no longer exists", {
        projectId: options.projectId,
        documentId,
      });

      activeSubscriptions.delete(documentId);
      subscribedDocuments.delete(documentId);
      pendingBinaryByDocument.delete(documentId);

      notifyDocumentTextListeners(documentId, {
        ...event,
        documentId,
      });
      return;
    }

    // NOT_SUBSCRIBED means the server rejected a command because the
    // subscribe→ack handshake hasn't completed (or was lost). Clear the
    // local "subscribed" flag and re-subscribe if the document is still
    // active. No resubscribe loop risk: the gate in sendDocumentCommand
    // prevents further commands until the next doc:subscribed ack.
    if (event.code === "NOT_SUBSCRIBED") {
      subscribedDocuments.delete(documentId);
      if (activeSubscriptions.has(documentId)) {
        pendingBinaryByDocument.set(documentId, []);
        sendDocSubscribe(documentId);
      }
    }

    notifyDocumentTextListeners(documentId, {
      ...event,
      documentId,
    });
  };

  const handleProposalEvent = (event: ProjectCollabProposalEvent) => {
    let eventDocumentId: string;

    if (isProposalNewEvent(event)) {
      eventDocumentId = normalizeDocumentId(event.proposal.documentId);
    } else {
      eventDocumentId = normalizeDocumentId(event.documentId);
    }

    if (!eventDocumentId) {
      return;
    }

    // Keep tree badge counts in sync without a full tree reload.
    if (isProposalNewEvent(event)) {
      useTreeStore.getState().adjustProposalCount(eventDocumentId, 1);
    } else if (isProposalStatusChangedEvent(event)) {
      useTreeStore.getState().adjustProposalCount(eventDocumentId, -1);
    }

    notifyDocumentTextListeners(eventDocumentId, event);
  };

  const handleBinaryMessage = (data: ArrayBuffer | ArrayBufferView) => {
    const inboundFrame = new Uint8Array(toUint8Array(data));

    let unwrappedDocumentId: string | null;
    try {
      unwrappedDocumentId = unwrapEnvelope(inboundFrame).documentId;
    } catch (error) {
      log.warn("failed to parse project collab envelope", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (unwrappedDocumentId == null) {
      return;
    }

    const documentId = normalizeDocumentId(unwrappedDocumentId);
    if (!documentId || !activeSubscriptions.has(documentId)) {
      return;
    }

    if (subscribedDocuments.has(documentId)) {
      notifyDocumentBinaryListeners(documentId, inboundFrame);
      return;
    }

    const pendingFrames = pendingBinaryByDocument.get(documentId);
    if (pendingFrames != null) {
      pendingFrames.push(inboundFrame);
      return;
    }

    pendingBinaryByDocument.set(documentId, [inboundFrame]);
  };

  const handleTextMessage = (
    rawData: string,
    sourceSocket: ProjectCollabWebSocket,
  ) => {
    const textEvent = parseCollabServerTextEvent(rawData);
    if (!textEvent) {
      return;
    }

    if (textEvent.type === "project:connected") {
      // Auth succeeded — safe to send commands now.
      replayActiveSubscriptions(sourceSocket);
      return;
    }

    if (textEvent.type === "heartbeat") {
      const openSocket = getOpenSocket();
      if (openSocket == null || openSocket !== sourceSocket) {
        return;
      }

      openSocket.send(buildHeartbeatAckMessage());
      return;
    }

    if (textEvent.type === "error") {
      if (textEvent.code === "AUTH_FAILED") {
        // Fire-and-forget warmup. Reconnect loop will resolve a fresh token.
        void refreshSessionFn();
        sourceSocket.close();
        return;
      }

      log.warn("project collab websocket error", {
        projectId: options.projectId,
        code: textEvent.code,
        message: textEvent.message,
      });
      return;
    }

    if (isDocSubscribedEvent(textEvent)) {
      handleDocSubscribed(textEvent);
      return;
    }

    if (isDocUnsubscribedEvent(textEvent)) {
      handleDocUnsubscribed(textEvent);
      return;
    }

    if (isDocErrorEvent(textEvent)) {
      handleDocError(textEvent);
      return;
    }

    if (isProposalSnapshotEvent(textEvent)) {
      handleProposalEvent(textEvent);
      return;
    }

    if (isProposalNewEvent(textEvent)) {
      handleProposalEvent(textEvent);
      return;
    }

    if (isProposalStatusChangedEvent(textEvent)) {
      handleProposalEvent(textEvent);
      return;
    }

    if (isProposalGroupAcceptResultEvent(textEvent)) {
      handleProposalEvent(textEvent);
      return;
    }

    if (isProposalUpdateDataEvent(textEvent)) {
      handleProposalEvent(textEvent);
    }
  };

  const connect = async () => {
    if (isStopped) {
      return;
    }

    let token: string | null;
    try {
      token = await resolveAccessTokenFn();
    } catch (error) {
      log.warn("failed to resolve project collab auth token", {
        projectId: options.projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleReconnect();
      return;
    }

    if (isStopped) {
      return;
    }

    if (!token) {
      scheduleReconnect();
      return;
    }

    let ws: ProjectCollabWebSocket;
    try {
      ws = createWebSocketFn(buildProjectWSURL(options.projectId));
    } catch (error) {
      log.warn("failed to create project collab websocket", {
        projectId: options.projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleReconnect();
      return;
    }

    ws.binaryType = "arraybuffer";
    websocket = ws;

    ws.onopen = () => {
      reconnectAttempt = 0;
      ws.send(token);
      // Subscriptions are replayed after "project:connected" ack from server.
    };

    ws.onmessage = (event) => {
      if (event == null) {
        return;
      }

      if (typeof event.data === "string") {
        handleTextMessage(event.data, ws);
        return;
      }

      if (isBinaryFrameData(event.data)) {
        handleBinaryMessage(event.data);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      if (websocket === ws) {
        websocket = null;
      }

      subscribedDocuments.clear();

      if (isStopped) {
        return;
      }

      scheduleReconnect();
    };
  };

  const start = () => {
    if (!isStopped) {
      return;
    }

    isStopped = false;
    void connect();
  };

  const stop = () => {
    if (isStopped) {
      return;
    }

    isStopped = true;
    clearReconnectTimer();
    reconnectAttempt = 0;

    const ws = websocket;
    websocket = null;
    if (ws != null) {
      ws.close();
    }

    activeSubscriptions.clear();
    subscribedDocuments.clear();
    pendingBinaryByDocument.clear();
    listenersByDocument.clear();
  };

  const subscribeDocument = (documentId: string) => {
    const normalizedDocumentId = normalizeDocumentId(documentId);
    if (
      !normalizedDocumentId ||
      activeSubscriptions.has(normalizedDocumentId)
    ) {
      return;
    }

    activeSubscriptions.add(normalizedDocumentId);
    subscribedDocuments.delete(normalizedDocumentId);
    pendingBinaryByDocument.set(normalizedDocumentId, []);

    sendDocSubscribe(normalizedDocumentId);
  };

  const unsubscribeDocument = (documentId: string) => {
    const normalizedDocumentId = normalizeDocumentId(documentId);
    if (!normalizedDocumentId) {
      return;
    }

    const hadSubscription = activeSubscriptions.delete(normalizedDocumentId);
    subscribedDocuments.delete(normalizedDocumentId);
    pendingBinaryByDocument.delete(normalizedDocumentId);

    if (hadSubscription) {
      sendDocUnsubscribe(normalizedDocumentId);
    }
  };

  const sendDocumentCommand = (
    documentId: string,
    command: Record<string, unknown>,
  ): boolean => {
    const normalizedDocumentId = normalizeDocumentId(documentId);
    if (
      !normalizedDocumentId ||
      !activeSubscriptions.has(normalizedDocumentId)
    ) {
      return false;
    }

    // Wait for the server to confirm the subscription before sending
    // commands. Without this gate, commands sent during the subscribe→ack
    // window are rejected with NOT_SUBSCRIBED on the server side.
    if (!subscribedDocuments.has(normalizedDocumentId)) {
      return false;
    }

    const ws = getOpenSocket();
    if (ws == null) {
      return false;
    }

    ws.send(
      JSON.stringify({
        ...command,
        documentId: normalizedDocumentId,
      }),
    );

    return true;
  };

  const sendDocumentBinary = (
    documentId: string,
    frame: Uint8Array,
  ): boolean => {
    const normalizedDocumentId = normalizeDocumentId(documentId);
    if (
      !normalizedDocumentId ||
      !activeSubscriptions.has(normalizedDocumentId)
    ) {
      return false;
    }

    let framedDocumentId: string | null;
    try {
      framedDocumentId = unwrapEnvelope(frame).documentId;
    } catch (error) {
      log.warn("failed to parse outbound project collab envelope", {
        documentId: normalizedDocumentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    if (
      framedDocumentId != null &&
      normalizeDocumentId(framedDocumentId) !== normalizedDocumentId
    ) {
      log.warn(
        "dropping outbound project collab frame with mismatched document",
        {
          expectedDocumentId: normalizedDocumentId,
          framedDocumentId,
        },
      );
      return false;
    }

    const ws = getOpenSocket();
    if (ws == null) {
      return false;
    }

    ws.send(frame);
    return true;
  };

  const registerDocumentListener = (
    documentId: string,
    listener: ProjectCollabDocumentListener,
  ): (() => void) => {
    const normalizedDocumentId = normalizeDocumentId(documentId);
    if (!normalizedDocumentId) {
      return () => {};
    }

    const listeners =
      listenersByDocument.get(normalizedDocumentId) ??
      new Set<ProjectCollabDocumentListener>();
    listeners.add(listener);
    listenersByDocument.set(normalizedDocumentId, listeners);

    return () => {
      const currentListeners = listenersByDocument.get(normalizedDocumentId);
      if (!currentListeners) {
        return;
      }

      currentListeners.delete(listener);
      if (currentListeners.size === 0) {
        listenersByDocument.delete(normalizedDocumentId);
      }
    };
  };

  return {
    start,
    stop,
    subscribeDocument,
    unsubscribeDocument,
    sendDocumentCommand,
    sendDocumentBinary,
    registerDocumentListener,
  };
}

export function useProjectCollab(projectId: string): ProjectCollabTransport {
  const transport = useMemo(() => {
    return createProjectCollabTransport({ projectId });
  }, [projectId]);

  useEffect(() => {
    transport.start();
    return () => {
      transport.stop();
    };
  }, [transport]);

  return useMemo(
    () => ({
      subscribeDocument: transport.subscribeDocument,
      unsubscribeDocument: transport.unsubscribeDocument,
      sendDocumentCommand: transport.sendDocumentCommand,
      sendDocumentBinary: transport.sendDocumentBinary,
      registerDocumentListener: transport.registerDocumentListener,
    }),
    [transport],
  );
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

function buildProjectWSURL(projectId: string): string {
  const base = normalizeAPIBase(API_BASE_URL);
  const url = new URL(`/ws/projects/${projectId}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function normalizeAPIBase(base: string): string {
  if (base.startsWith("http://") || base.startsWith("https://")) {
    return base;
  }

  return `http://${base}`;
}

function normalizeDocumentId(documentId: string): string {
  return documentId.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isDocSubscribedEvent(event: unknown): event is DocSubscribedEvent {
  if (!isRecord(event)) {
    return false;
  }

  return (
    event.type === "doc:subscribed" && typeof event.documentId === "string"
  );
}

function isDocUnsubscribedEvent(event: unknown): event is DocUnsubscribedEvent {
  if (!isRecord(event)) {
    return false;
  }

  return (
    event.type === "doc:unsubscribed" && typeof event.documentId === "string"
  );
}

function isDocErrorEvent(event: unknown): event is DocErrorEvent {
  if (!isRecord(event)) {
    return false;
  }

  return (
    event.type === "doc:error" &&
    typeof event.documentId === "string" &&
    typeof event.code === "string" &&
    typeof event.message === "string"
  );
}

function isBinaryFrameData(
  data: unknown,
): data is ArrayBuffer | ArrayBufferView {
  return data instanceof ArrayBuffer || ArrayBuffer.isView(data);
}
