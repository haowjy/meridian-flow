import { decodeYjsBinaryEnvelope, parseYjsServerControlFrame } from "@meridian/contracts/protocol";
import { serverWebSocketUrl } from "./server-origin";

export type DocumentSubscriptionHandlers = {
  onStatus(status: string): void;
  onMarkdown(markdown: string): void;
  onError(error: string): void;
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
    if (update) handlers.onMarkdown(update.markdown);
  });

  socket.addEventListener("close", () => handlers.onStatus("closed"));
  socket.addEventListener("error", () => handlers.onError("yjs websocket error"));

  return () => socket.close();
}

function parseMarkdownReplace(payload: Uint8Array): { markdown: string } | null {
  try {
    const decoded = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    if (!decoded || typeof decoded !== "object") return null;
    if (!("type" in decoded) || decoded.type !== "markdown-replace") return null;
    if (!("markdown" in decoded) || typeof decoded.markdown !== "string") return null;
    return { markdown: decoded.markdown };
  } catch {
    return null;
  }
}
