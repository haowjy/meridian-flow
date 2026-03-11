import { API_BASE_URL } from "@/core/lib/api";
import { makeLogger } from "@/core/lib/logger";
import { createClient } from "@/core/supabase/client";
import {
  CollabSyncRuntime,
  buildHeartbeatAckMessage,
  createCollabSyncRuntime,
  parseCollabServerTextEvent,
  toUint8Array,
} from "./runtime";

const log = makeLogger("document-session-manager");
const WS_OPEN = 1;

export type DocumentSessionStatus =
  | "connecting"
  | "authenticating"
  | "syncing"
  | "connected"
  | "disconnected";

export interface DocumentSession {
  documentId: string;
  ws: WebSocket;
  runtime: CollabSyncRuntime;
  status: DocumentSessionStatus;
}

interface ManagedDocumentSession extends DocumentSession {
  refCount: number;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  isReleased: boolean;
}

export class DocumentSessionManager {
  private readonly sessions = new Map<string, ManagedDocumentSession>();
  private readonly statusListeners = new Map<
    string,
    Set<(status: DocumentSessionStatus) => void>
  >();
  private activeSessionId: string | null = null;
  private isDestroyed = false;

  constructor(private readonly getAuthToken: () => Promise<string | null>) {}

  acquire(documentId: string): DocumentSession {
    if (this.isDestroyed) {
      throw new Error("DocumentSessionManager is destroyed");
    }

    const normalizedDocumentId = normalizeDocumentId(documentId);
    const existing = this.sessions.get(normalizedDocumentId);
    if (existing) {
      existing.refCount += 1;
      existing.isReleased = false;
      this.activeSessionId = normalizedDocumentId;
      return existing;
    }

    const runtime = createCollabSyncRuntime({
      documentId: normalizedDocumentId,
      sendBinary: (frame) => {
        const ws = this.sessions.get(normalizedDocumentId)?.ws;
        if (!ws || ws.readyState !== WS_OPEN) {
          return;
        }
        ws.send(frame);
      },
      onStatusChange: (status) => {
        const session = this.sessions.get(normalizedDocumentId);
        if (!session || session.isReleased) {
          return;
        }
        if (status === "syncing") {
          this.setSessionStatus(session, "syncing");
          return;
        }
        if (status === "connected") {
          this.setSessionStatus(session, "connected");
        }
      },
    });

    const ws = new WebSocket(buildDocumentWSURL(normalizedDocumentId));
    ws.binaryType = "arraybuffer";

    const session: ManagedDocumentSession = {
      documentId: normalizedDocumentId,
      ws,
      runtime,
      status: "connecting",
      refCount: 1,
      reconnectAttempt: 0,
      reconnectTimer: null,
      isReleased: false,
    };

    this.sessions.set(normalizedDocumentId, session);
    this.activeSessionId = normalizedDocumentId;
    this.attachSocket(session, ws);

    return session;
  }

  release(documentId: string): void {
    const normalizedDocumentId = normalizeDocumentId(documentId);
    const session = this.sessions.get(normalizedDocumentId);
    if (!session) {
      return;
    }

    session.refCount = Math.max(0, session.refCount - 1);
    if (session.refCount > 0) {
      return;
    }

    session.isReleased = true;
    if (session.reconnectTimer != null) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }

    session.ws.onopen = null;
    session.ws.onmessage = null;
    session.ws.onerror = null;
    session.ws.onclose = null;
    session.ws.close();

    this.setSessionStatus(session, "disconnected");
    session.runtime.destroy();
    this.sessions.delete(normalizedDocumentId);
    if (this.activeSessionId === normalizedDocumentId) {
      this.activeSessionId = null;
    }
  }

  onStatusChange(
    documentId: string,
    callback: (status: DocumentSessionStatus) => void,
  ): () => void {
    const normalizedDocumentId = normalizeDocumentId(documentId);
    const listeners =
      this.statusListeners.get(normalizedDocumentId) ??
      new Set<(status: DocumentSessionStatus) => void>();
    listeners.add(callback);
    this.statusListeners.set(normalizedDocumentId, listeners);

    const session = this.sessions.get(normalizedDocumentId);
    if (session) {
      callback(session.status);
    } else {
      callback("disconnected");
    }

    return () => {
      const current = this.statusListeners.get(normalizedDocumentId);
      if (!current) {
        return;
      }
      current.delete(callback);
      if (current.size === 0) {
        this.statusListeners.delete(normalizedDocumentId);
      }
    };
  }

  destroy(): void {
    if (this.isDestroyed) {
      return;
    }

    this.isDestroyed = true;
    for (const session of this.sessions.values()) {
      if (session.reconnectTimer != null) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
      }
      session.ws.onopen = null;
      session.ws.onmessage = null;
      session.ws.onerror = null;
      session.ws.onclose = null;
      session.ws.close();
      session.runtime.destroy();
    }

    this.sessions.clear();
    this.statusListeners.clear();
    this.activeSessionId = null;
  }

  private attachSocket(session: ManagedDocumentSession, ws: WebSocket): void {
    ws.onopen = async () => {
      if (this.isDestroyed || session.isReleased || session.ws !== ws) {
        return;
      }

      session.reconnectAttempt = 0;
      this.setSessionStatus(session, "authenticating");

      let token: string | null;
      try {
        token = await this.getAuthToken();
      } catch (error) {
        log.warn("failed to resolve document collab auth token", {
          documentId: session.documentId,
          error: error instanceof Error ? error.message : String(error),
        });
        ws.close();
        return;
      }

      if (!token || this.isDestroyed || session.isReleased || session.ws !== ws) {
        ws.close();
        return;
      }

      ws.send(token);
    };

    ws.onmessage = (event) => {
      if (this.isDestroyed || session.isReleased || session.ws !== ws) {
        return;
      }

      if (typeof event.data === "string") {
        this.handleTextMessage(session, ws, event.data);
        return;
      }

      if (isBinaryFrameData(event.data)) {
        try {
          session.runtime.handleBinaryFrame(toUint8Array(event.data));
        } catch (error) {
          log.warn("failed to handle document collab binary frame", {
            documentId: session.documentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      if (session.ws === ws) {
        this.setSessionStatus(session, "disconnected");
      }

      if (
        this.isDestroyed ||
        session.isReleased ||
        session.refCount <= 0 ||
        session.ws !== ws
      ) {
        return;
      }

      this.scheduleReconnect(session);
    };
  }

  private handleTextMessage(
    session: ManagedDocumentSession,
    ws: WebSocket,
    rawData: string,
  ): void {
    const message = parseCollabServerTextEvent(rawData);
    if (!message) {
      return;
    }

    if (message.type === "heartbeat") {
      if (session.ws === ws && ws.readyState === WS_OPEN) {
        ws.send(buildHeartbeatAckMessage());
      }
      return;
    }

    if (message.type === "connected") {
      this.setSessionStatus(session, "syncing");
      session.runtime.startSync();
      return;
    }

    if (message.type === "error") {
      if (message.code === "AUTH_FAILED" || message.code === "AUTH_EXPIRED") {
        void createClient().auth.refreshSession();
      }
      log.warn("document collab websocket error", {
        documentId: session.documentId,
        code: message.code,
        message: message.message,
      });
      ws.close();
    }
  }

  private scheduleReconnect(session: ManagedDocumentSession): void {
    if (session.reconnectTimer != null) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }

    const attempt = session.reconnectAttempt;
    const baseDelay = Math.min(5000, 250 * 2 ** attempt);
    const jitter = baseDelay * 0.15 * (Math.random() * 2 - 1);
    const delayMs = Math.max(100, Math.round(baseDelay + jitter));

    session.reconnectAttempt = attempt + 1;
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      if (this.isDestroyed || session.isReleased || session.refCount <= 0) {
        return;
      }

      const nextSocket = new WebSocket(buildDocumentWSURL(session.documentId));
      nextSocket.binaryType = "arraybuffer";
      session.ws = nextSocket;
      this.setSessionStatus(session, "connecting");
      this.attachSocket(session, nextSocket);
    }, delayMs);
  }

  private setSessionStatus(
    session: ManagedDocumentSession,
    status: DocumentSessionStatus,
  ): void {
    if (session.status === status) {
      return;
    }

    session.status = status;
    const listeners = this.statusListeners.get(session.documentId);
    if (!listeners) {
      return;
    }
    for (const callback of listeners) {
      callback(status);
    }
  }
}

export async function resolveDocumentAccessToken(): Promise<string | null> {
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

function normalizeDocumentId(documentId: string): string {
  return documentId.trim().toLowerCase();
}

function isBinaryFrameData(
  data: unknown,
): data is ArrayBuffer | ArrayBufferView {
  return data instanceof ArrayBuffer || ArrayBuffer.isView(data);
}
