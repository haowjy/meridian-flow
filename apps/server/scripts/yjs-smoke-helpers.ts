import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import { markdownFromState } from "../server/domains/collab/domain/yjs-mirror.js";

export async function waitForHocuspocusMarkdown(options: {
  wsUrl: string;
  documentId: string;
  authHeaders: Record<string, string>;
  expectedSubstring: string;
  timeoutMs?: number;
}): Promise<string> {
  const { wsUrl, documentId, authHeaders, expectedSubstring, timeoutMs = 10_000 } = options;
  const doc = new Y.Doc();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      provider.destroy();
      doc.destroy();
      reject(new Error("timed out waiting for Hocuspocus markdown sync"));
    }, timeoutMs);

    const provider = new HocuspocusProvider({
      url: wsUrl,
      name: documentId,
      document: doc,
      WebSocketPolyfill: class extends WebSocket {
        constructor(url: string | URL, _protocols?: string | string[]) {
          super(url, { headers: authHeaders });
        }
      } as typeof WebSocket,
      onSynced() {
        const markdown = markdownFromState("document", Y.encodeStateAsUpdate(doc));
        if (markdown.includes(expectedSubstring)) {
          clearTimeout(timeout);
          provider.destroy();
          doc.destroy();
          resolve(markdown);
        }
      },
    });
  });
}
