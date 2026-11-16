import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";
import { isSignInLapse } from "./document-session";

/**
 * The room exactly as the server holds it now: one sync into a fresh document, with no local copy,
 * no presence and nothing sent. Null when the server won't admit this client to the room (closed,
 * removed, access ended, a schema this build can't open). Waits while offline.
 */
export function readRoomOnce(roomKey: string): Promise<Y.Doc | null> {
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  awareness.setLocalState(null);
  const transport = createHocuspocusDocumentTransport({ roomName: roomKey, document, awareness });
  return new Promise((resolve) => {
    let done = false;
    let stop = () => {};
    const finish = (read: Y.Doc | null) => {
      if (done) return;
      done = true;
      stop();
      void transport.destroy();
      awareness.destroy();
      if (!read) document.destroy();
      resolve(read);
    };
    stop =
      transport.subscribeStatus?.((state) => {
        if (
          state.kind === "reset" ||
          state.kind === "terminal" ||
          (state.kind === "unauthorized" && !isSignInLapse(state))
        )
          finish(null);
      }) ?? stop;
    if (done) stop();
    void transport.whenSynced?.then(() => finish(document));
  });
}
