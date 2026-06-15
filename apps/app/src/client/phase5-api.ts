import type { AGUIEvent, SendMessageResponse, WsServerMessage } from "@meridian/contracts/protocol";
import { parseWsServerMessage } from "@meridian/contracts/protocol";
import { serverOrigin, serverWebSocketUrl } from "./server-origin";

export const CHAPTER_URI = "manuscript://chapter-1.md";

export type DefaultBootstrap = {
  projectId: string;
  workId: string;
  threadId: string;
  documentId: string;
  contextSourceId: string;
  agentDefinitionId: string;
  uri: typeof CHAPTER_URI;
};

export type ContextDocument = {
  documentId: string;
  uri: string;
  markdown: string;
};

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function bootstrapDefaultProject(): Promise<DefaultBootstrap> {
  const response = await fetch(`${serverOrigin()}/api/projects/bootstrap-default`, {
    method: "POST",
    credentials: "include",
  });
  return readJson<DefaultBootstrap>(response);
}

export async function readThreadContext(
  threadId: string,
  uri = CHAPTER_URI,
): Promise<ContextDocument> {
  const response = await fetch(
    `${serverOrigin()}/api/threads/${encodeURIComponent(threadId)}/context?uri=${encodeURIComponent(uri)}`,
    { credentials: "include" },
  );
  return readJson<ContextDocument>(response);
}

export async function sendThreadMessage(
  threadId: string,
  text: string,
): Promise<SendMessageResponse> {
  const response = await fetch(
    `${serverOrigin()}/api/threads/${encodeURIComponent(threadId)}/messages`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  return readJson<SendMessageResponse>(response);
}

export type ThreadEventHandlers = {
  onStatus(status: string): void;
  onEvent(event: AGUIEvent): void;
  onError(error: string): void;
};

export function subscribeThreadEvents(threadId: string, handlers: ThreadEventHandlers): () => void {
  const socket = new WebSocket(serverWebSocketUrl("/api/threads/ws"));

  socket.addEventListener("open", () => {
    handlers.onStatus("connected");
    socket.send(JSON.stringify({ type: "subscribe", threadId }));
  });

  socket.addEventListener("message", (message) => {
    const parsed = parseWsServerMessage(String(message.data));
    if (!parsed) return;
    handleThreadFrame(socket, parsed, handlers);
  });

  socket.addEventListener("close", () => handlers.onStatus("closed"));
  socket.addEventListener("error", () => handlers.onError("thread websocket error"));

  return () => socket.close();
}

function handleThreadFrame(
  socket: WebSocket,
  message: WsServerMessage,
  handlers: ThreadEventHandlers,
): void {
  switch (message.type) {
    case "connected":
      handlers.onStatus("connected");
      return;
    case "subscribed":
      handlers.onStatus("subscribed");
      for (const entry of message.catchup) handlers.onEvent(entry.event);
      return;
    case "event":
      handlers.onEvent(message.event);
      return;
    case "ping":
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    case "gap":
      handlers.onError(message.message ?? message.cause);
      return;
    case "error":
      handlers.onError(message.error.message);
      return;
  }
}
