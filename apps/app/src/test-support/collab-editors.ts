/**
 * Two editors over one shared document, for surfaces that have to survive a peer's write.
 *
 * The hazard these tests exist for cannot be faked with a hand-built transaction: a remote write
 * reaches the editor through the binding (`importRemoteUpdate`), which rebuilds the blocks it
 * changed and dispatches them as one remote transaction. Only a real second copy produces that,
 * so this runs a real second editor and hands its batches over the way a server would.
 *
 * It also mounts them the way production does: `useMountedEditor` reconciles surface options onto
 * the running editor right after construction (`setOptions`, which runs `view.updateState`).
 */

import { type DocChange, encodeEnvelope, freshPeerId, RoomDocs } from "@meridian/document-model";
import { importRemoteUpdate } from "@meridian/loro-prosemirror";
import { Editor, type JSONContent } from "@tiptap/core";

import { createEditorConfig } from "@/core/editor/config";
import { DocumentHistory } from "@/core/editor/editor-history";
import {
  createLocalPresence,
  type LocalPresence,
  type PeerState,
} from "@/core/editor/local-presence";
import { documentShape } from "@/core/editor/room-content";

/** What a copy shows on the wire for itself. */
type WireView = { getLocalState(): PeerState | null };

export type CollabPair = {
  /** The editor under test. */
  local: Editor;
  /** The collaborator. Write through this, then `sync()`. */
  peer: Editor;
  /** Exchange document batches both ways, as a connected server would. */
  sync: () => void;
  /**
   * Exchange presence both ways, for a lane whose subject is ephemeral. Separate from `sync()` on
   * purpose: presence carries collaborator carets too, so a suite that exchanges it opts into the
   * peer's cursor decorations appearing in the document under test.
   */
  syncAwareness: () => void;
  awareness: { local: WireView; peer: WireView };
  /**
   * The editor under test's presence owner, as a `DocumentSession` would hold it: `suspend()` is
   * what a surface like inline review does to the writer's presence while it is open.
   */
  presence: LocalPresence;
  destroy: () => void;
};

type Copy = { docs: RoomDocs; presence: LocalPresence; editor: Editor | null };

function copyOf(): Copy {
  const peer = freshPeerId();
  return {
    docs: RoomDocs.create(documentShape(), peer),
    presence: createLocalPresence(peer),
    editor: null,
  };
}

function mount(copy: Copy): Editor {
  const history = new DocumentHistory(copy.docs, () => {});
  const editor = new Editor({
    element: document.createElement("div"),
    ...createEditorConfig({
      copy: { docs: copy.docs, publish: (_changes: readonly DocChange[]) => {} },
      history,
      presence: copy.presence,
    }),
  });
  history.attach(editor);
  // The post-mount reconciliation `useMountedEditor` performs.
  editor.setOptions({ editable: editor.isEditable });
  editor.setEditable(true, false);
  copy.editor = editor;
  return editor;
}

function push(from: Copy, to: Copy): void {
  const batch = from.docs.exportSince(to.docs.version());
  if (batch.size > 0) importRemoteUpdate(to.docs, encodeEnvelope(batch));
}

function wireView(copy: Copy): WireView {
  return {
    getLocalState: () =>
      (copy.presence.store.get(copy.presence.peers.clientID) as PeerState | undefined) ?? null,
  };
}

/** Both editors bound to the same content: the collaborator writes it, the editor under test joins. */
export function createCollabPair(content: JSONContent): CollabPair {
  const local = copyOf();
  const peer = copyOf();
  const peerEditor = mount(peer);
  peerEditor.commands.setContent(content);
  push(peer, local);
  const localEditor = mount(local);

  const sync = () => {
    push(local, peer);
    push(peer, local);
  };
  sync();

  return {
    local: localEditor,
    peer: peerEditor,
    sync,
    syncAwareness: () => {
      peer.presence.store.apply(local.presence.store.encodeAll());
      local.presence.store.apply(peer.presence.store.encodeAll());
    },
    awareness: { local: wireView(local), peer: wireView(peer) },
    presence: local.presence,
    destroy: () => {
      peerEditor.destroy();
      localEditor.destroy();
      local.presence.release();
      peer.presence.release();
      local.docs.free();
      peer.docs.free();
    },
  };
}
