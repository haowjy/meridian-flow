/**
 * Two editors over one shared document, for surfaces that have to survive a
 * peer's write.
 *
 * The hazard these tests exist for cannot be faked with a hand-built
 * transaction: what makes a remote write different is that y-prosemirror
 * REBUILDS the ProseMirror doc from the Yjs type and dispatches one replace
 * step over the whole document. Only a real second binding produces that, so
 * this runs a real second editor and hands its updates over the way a server
 * would.
 *
 * It also mounts them the way production does. `useMountedEditor` reconciles
 * surface options onto the running editor right after construction, and that
 * `setOptions` call is load-bearing here: it runs `view.updateState`, which is
 * where y-prosemirror decides the editor has real content and may write to the
 * shared document. A harness that skips it leaves the binding still guarding
 * its initial content, and the first edit that reduces a document to the
 * schema default — deleting its only block — is silently never sent.
 */

import { Editor, type JSONContent } from "@tiptap/core";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorConfig } from "@/core/editor/config";
import type { SessionMarkerStore } from "@/core/editor/session-marker-store";

export type CollabPair = {
  /** The editor under test. */
  local: Editor;
  /** The collaborator. Write through this, then `sync()`. */
  peer: Editor;
  /** Exchange updates both ways, as a connected server would. */
  sync: () => void;
  destroy: () => void;
};

function editorOn(doc: Y.Doc, markerStore?: SessionMarkerStore): Editor {
  return new Editor({
    element: document.createElement("div"),
    ...createEditorConfig({ document: doc, awareness: new Awareness(doc), markerStore }),
  });
}

/** The post-mount reconciliation `useMountedEditor` performs, and why. */
function reconcileMount(editor: Editor): void {
  editor.setOptions({ editable: editor.isEditable });
  editor.setEditable(true, false);
}

function push(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

/**
 * Both editors bound to the same content. The local one is filled first and
 * its state handed over before the peer mounts: two bindings both initializing
 * an empty document would each contribute a paragraph.
 */
export function createCollabPair(
  content: JSONContent,
  /** Peer marks project into the editor under test only, as they do in the app. */
  options: { markerStore?: SessionMarkerStore } = {},
): CollabPair {
  const localDoc = new Y.Doc({ gc: false });
  const peerDoc = new Y.Doc({ gc: false });

  const local = editorOn(localDoc, options.markerStore);
  local.commands.setContent(content);
  reconcileMount(local);
  push(localDoc, peerDoc);
  const peer = editorOn(peerDoc);
  reconcileMount(peer);

  const sync = () => {
    push(localDoc, peerDoc);
    push(peerDoc, localDoc);
  };
  sync();

  return {
    local,
    peer,
    sync,
    destroy: () => {
      peer.destroy();
      local.destroy();
    },
  };
}
