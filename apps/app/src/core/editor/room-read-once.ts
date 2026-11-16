import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createHocuspocusDocumentTransport } from "@/core/transport/hocuspocus-document-transport";
import { isSignInLapse } from "./document-session";
import { createLocalPresence } from "./local-presence";

/**
 * The room exactly as the server holds it now: one sync into a fresh document, with no local copy,
 * no presence and nothing sent. Otherwise why the server won't admit this client to the room:
 * `schema` when only a reload of the tab can open it, `refused` for anything else (closed, removed,
 * access ended). Waits while offline; rejects, and closes the room, when `signal` aborts.
 */
export function readRoomOnce(
  roomKey: string,
  signal: AbortSignal,
): Promise<Y.Doc | "schema" | "refused"> {
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  createLocalPresence(awareness).suspend();
  const transport = createHocuspocusDocumentTransport({ roomName: roomKey, document, awareness });
  return new Promise((resolve, reject) => {
    let done = false;
    let stop = () => {};
    const finish = (read: Y.Doc | "schema" | "refused" | Error) => {
      if (done) return;
      done = true;
      stop();
      signal.removeEventListener("abort", aborted);
      void transport.destroy();
      awareness.destroy();
      if (!(read instanceof Y.Doc)) document.destroy();
      if (read instanceof Error) reject(read);
      else resolve(read);
    };
    const aborted = () => finish(new DOMException("The read was stopped.", "AbortError"));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted);
    stop =
      transport.subscribeStatus?.((state) => {
        if (state.kind === "reset") finish(state.disposition === "schema" ? "schema" : "refused");
        else if (
          state.kind === "terminal" ||
          (state.kind === "unauthorized" && !isSignInLapse(state))
        )
          finish("refused");
      }) ?? stop;
    if (done) stop();
    void transport.whenSynced?.then(() => finish(document));
  });
}
