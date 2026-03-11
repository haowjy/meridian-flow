import { useEffect, useMemo } from "react";
import {
  buildHeartbeatAckMessage,
  isProposalGroupAcceptResultEvent,
  isProposalNewEvent,
  isProposalSnapshotEvent,
  isProposalStatusChangedEvent,
  isProposalUpdateDataEvent,
  parseCollabServerTextEvent,
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

export type ProjectCollabProposalEvent =
  | ProposalSnapshotEvent
  | ProposalNewEvent
  | ProposalStatusChangedEvent
  | ProposalGroupAcceptResultEvent
  | ProposalUpdateDataEvent;

export interface ProjectCollabDocErrorEvent {
  type: "doc:error";
  documentId: string;
  code: string;
  message: string;
}

export type ProjectCollabDocumentTextEvent =
  | ProjectCollabProposalEvent
  | ProjectCollabDocErrorEvent;

export interface ProjectCollabDocumentListener {
  onTextEvent?: (event: ProjectCollabDocumentTextEvent) => void;
}

export interface ProjectCollabTransport {
  sendDocumentCommand: (documentId: string, command: Record<string, unknown>) => void;
  registerDocumentListener: (
    documentId: string,
    listener: ProjectCollabDocumentListener,
  ) => () => void;
  isConnected: () => boolean;
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
  let isAuthenticated = false;

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

    if (isProposalNewEvent(event)) {
      useTreeStore.getState().adjustProposalCount(eventDocumentId, 1);
    } else if (isProposalStatusChangedEvent(event)) {
      useTreeStore.getState().adjustProposalCount(eventDocumentId, -1);
    }

    notifyDocumentTextListeners(eventDocumentId, event);
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
      if (websocket === sourceSocket) {
        isAuthenticated = true;
      }
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
      if (
        textEvent.code === "AUTH_FAILED" ||
        textEvent.code === "AUTH_EXPIRED"
      ) {
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

    if (
      textEvent.type === "doc:error" &&
      typeof textEvent.documentId === "string" &&
      typeof textEvent.code === "string" &&
      typeof textEvent.message === "string"
    ) {
      const eventDocumentId = normalizeDocumentId(textEvent.documentId);
      if (!eventDocumentId) {
        return;
      }
      notifyDocumentTextListeners(eventDocumentId, {
        type: "doc:error",
        documentId: eventDocumentId,
        code: textEvent.code,
        message: textEvent.message,
      });
      return;
    }

    if (
      isProposalSnapshotEvent(textEvent) ||
      isProposalNewEvent(textEvent) ||
      isProposalStatusChangedEvent(textEvent) ||
      isProposalGroupAcceptResultEvent(textEvent) ||
      isProposalUpdateDataEvent(textEvent)
    ) {
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
    isAuthenticated = false;

    ws.onopen = () => {
      reconnectAttempt = 0;
      ws.send(token);
    };

    ws.onmessage = (event) => {
      if (event == null) {
        return;
      }

      if (typeof event.data === "string") {
        handleTextMessage(event.data, ws);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      if (websocket === ws) {
        websocket = null;
      }

      isAuthenticated = false;

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
    isAuthenticated = false;

    const ws = websocket;
    websocket = null;
    if (ws != null) {
      ws.close();
    }

    listenersByDocument.clear();
  };

  const sendDocumentCommand = (
    documentId: string,
    command: Record<string, unknown>,
  ): void => {
    const normalizedDocumentId = normalizeDocumentId(documentId);
    if (!normalizedDocumentId || !isAuthenticated) {
      return;
    }

    const ws = getOpenSocket();
    if (ws == null) {
      return;
    }

    ws.send(
      JSON.stringify({
        ...command,
        documentId: normalizedDocumentId,
      }),
    );
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

  const isConnected = (): boolean => {
    return isAuthenticated && getOpenSocket() != null;
  };

  return {
    start,
    stop,
    sendDocumentCommand,
    registerDocumentListener,
    isConnected,
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
      sendDocumentCommand: transport.sendDocumentCommand,
      registerDocumentListener: transport.registerDocumentListener,
      isConnected: transport.isConnected,
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
