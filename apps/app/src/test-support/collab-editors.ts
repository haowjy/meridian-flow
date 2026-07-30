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
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorConfig } from "@/core/editor/config";
import { createLocalPresence, type LocalPresence } from "@/core/editor/local-presence";
import type { SessionMarkerStore } from "@/core/editor/session-marker-store";

export type CollabPair = {
  /** The editor under test. */
  local: Editor;
  /** The collaborator. Write through this, then `sync()`. */
  peer: Editor;
  /** Exchange document updates both ways, as a connected server would. */
  sync: () => void;
  /**
   * Exchange AWARENESS both ways, for a lane whose subject is ephemeral.
   *
   * Separate from `sync()` on purpose: awareness carries collaborator carets
   * too, so a suite that exchanges it opts into the peer's cursor decorations
   * appearing in the document under test.
   */
  syncAwareness: () => void;
  awareness: { local: Awareness; peer: Awareness };
  /**
   * The editor under test's presence owner, as a `DocumentSession` would hold
   * it: `suspend()` is what a surface like inline review does to the writer's
   * presence while it is open.
   */
  presence: LocalPresence;
  destroy: () => void;
};

function editorOn(doc: Y.Doc, presence: LocalPresence, markerStore?: SessionMarkerStore): Editor {
  return new Editor({
    element: document.createElement("div"),
    ...createEditorConfig({ document: doc, presence, markerStore }),
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

function pushAwareness(from: Awareness, to: Awareness): void {
  const clients = Array.from(from.getStates().keys());
  if (clients.length === 0) return;
  applyAwarenessUpdate(to, encodeAwarenessUpdate(from, clients), "collab-pair");
}

/**
 * Both editors bound to the same content.
 *
 * The COLLABORATOR mounts first, while both documents are still empty, so it is
 * the one binding that initializes the shared type — two bindings initializing
 * an empty document would each contribute a paragraph. The editor under test
 * then joins a room that already exists, which is what production does, and
 * the content arriving as a whole-document replace is the very thing these
 * tests are about.
 *
 * Joining an existing room is also the only order that leaves the collaborator
 * a selection it can honor. A binding mounting onto non-empty content carries
 * its own selection across the rebuild, and its default is position 1 — inside
 * an empty paragraph, but between blocks in a document whose first block is an
 * atom (a figure). ProseMirror warned about exactly that on the way past.
 */
export function createCollabPair(
  content: JSONContent,
  /** Peer marks project into the editor under test only, as they do in the app. */
  options: { markerStore?: SessionMarkerStore } = {},
): CollabPair {
  const localDoc = new Y.Doc({ gc: false });
  const peerDoc = new Y.Doc({ gc: false });
  const localAwareness = new Awareness(localDoc);
  const peerAwareness = new Awareness(peerDoc);
  const localPresence = createLocalPresence(localAwareness);

  const peer = editorOn(peerDoc, createLocalPresence(peerAwareness));
  reconcileMount(peer);
  push(peerDoc, localDoc);
  const local = editorOn(localDoc, localPresence, options.markerStore);
  reconcileMount(local);
  local.commands.setContent(content);

  const sync = () => {
    push(localDoc, peerDoc);
    push(peerDoc, localDoc);
  };
  sync();

  return {
    local,
    peer,
    sync,
    syncAwareness: () => {
      pushAwareness(localAwareness, peerAwareness);
      pushAwareness(peerAwareness, localAwareness);
    },
    awareness: { local: localAwareness, peer: peerAwareness },
    presence: localPresence,
    destroy: () => {
      peer.destroy();
      local.destroy();
      peerAwareness.destroy();
      localAwareness.destroy();
    },
  };
}
