import { decodeYjsBinaryEnvelope, parseYjsServerControlFrame } from "@meridian/contracts/protocol";
import { serverWebSocketUrl } from "./server-origin";

export type DocumentSubscriptionHandlers = {
  onStatus(status: string): void;
  onUpdate(update: DocumentMarkdownUpdate): void;
  onError(error: string): void;
};

export type DocumentMarkdownUpdate = {
  markdown: string;
  originType: string | null;
  actorTurnId: string | null;
  actorUserId: string | null;
};

export function subscribeDocumentUpdates(
  documentId: string,
  handlers: DocumentSubscriptionHandlers,
): () => void {
  const socket = new WebSocket(serverWebSocketUrl("/ws/yjs"));
  socket.binaryType = "arraybuffer";

  socket.addEventListener("open", () => {
    handlers.onStatus("connected");
    socket.send(JSON.stringify({ type: "subscribe", documentId }));
  });

  socket.addEventListener("message", (message) => {
    if (typeof message.data === "string") {
      const control = parseYjsServerControlFrame(message.data);
      if (!control) return;
      if (control.type === "subscribed") handlers.onStatus("subscribed");
      else handlers.onError(control.reason);
      return;
    }

    const bytes = new Uint8Array(message.data as ArrayBuffer);
    const envelope = decodeYjsBinaryEnvelope(bytes);
    if (!envelope) return;
    const update = parseMarkdownReplace(envelope.payload);
    if (update) handlers.onUpdate(update);
  });

  socket.addEventListener("close", () => handlers.onStatus("closed"));
  socket.addEventListener("error", () => handlers.onError("yjs websocket error"));

  return () => socket.close();
}

function parseMarkdownReplace(payload: Uint8Array): DocumentMarkdownUpdate | null {
  try {
    const decoded = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    if (!decoded || typeof decoded !== "object") return null;
    if (!("type" in decoded) || decoded.type !== "markdown-replace") return null;
    if (!("markdown" in decoded) || typeof decoded.markdown !== "string") return null;
    return {
      markdown: decoded.markdown,
      originType:
        "originType" in decoded && typeof decoded.originType === "string"
          ? decoded.originType
          : null,
      actorTurnId:
        "actorTurnId" in decoded && typeof decoded.actorTurnId === "string"
          ? decoded.actorTurnId
          : null,
      actorUserId:
        "actorUserId" in decoded && typeof decoded.actorUserId === "string"
          ? decoded.actorUserId
          : null,
    };
  } catch {
    return null;
  }
}
