/**
 * The tab side of `client-resync`: the production document transport
 * (`apps/app/src/core/transport/hocuspocus-document-transport.ts`) over its own Y.Doc, bundled
 * by the probe with esbuild so the app's `@/` imports and `import.meta.env` resolve. Plain
 * JavaScript, so the QA tools' TypeScript project never compiles app sources.
 *
 * The socket is whatever `globalThis.WebSocket` is when this bundle loads: the probe installs
 * its in-memory pipe first.
 */

import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";

/** One tab on `roomName`: an empty Y.Doc that syncs from the server, as a draft tab without a cache does. */
export function openTab(roomName) {
  const doc = new Y.Doc({ gc: false });
  const awareness = new Awareness(doc);
  const transport = createHocuspocusDocumentTransport({ roomName, document: doc, awareness });
  const states = [];
  const acknowledged = [];
  const stopStatus = transport.subscribeStatus?.((state) => states.push(state));
  const stopAck = transport.subscribeServerAcknowledgement?.((value) => acknowledged.push(value));
  const text = () => {
    const paragraph = doc.getXmlFragment("prosemirror").get(0);
    return paragraph ? paragraph.get(0) : null;
  };
  return {
    /** The paragraph's text has loaded from the server. */
    loaded: () => text() !== null,
    /** A keystroke at the end of the first paragraph, as the editor would apply it. */
    type(token) {
      const node = text();
      if (!node) throw new Error("the tab has no paragraph to type into");
      node.insert(node.length, token);
    },
    text: () => doc.getXmlFragment("prosemirror").toString(),
    clientID: () => doc.clientID,
    unacknowledged: () => transport.unacknowledgedUpdates(),
    acknowledged: () => acknowledged.at(-1) === true,
    states,
    destroy() {
      stopStatus?.();
      stopAck?.();
      transport.destroy();
      awareness.destroy();
      doc.destroy();
    },
  };
}
