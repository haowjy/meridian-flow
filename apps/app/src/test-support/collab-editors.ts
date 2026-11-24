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

type WireView = { getLocalState(): PeerState | null };

export type CollabPair = {
  local: Editor;
  peer: Editor;
  sync: () => void;
  syncAwareness: () => void;
  awareness: { local: WireView; peer: WireView };
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
  editor.setOptions({ editable: editor.isEditable });
  editor.setEditable(true, false);
  copy.editor = editor;
  return editor;
}

function push(from: Copy, to: Copy): void {
  const batch = from.docs.exportSince(to.docs.version());
  if (batch.size > 0) importRemoteUpdate(to.docs, encodeEnvelope(batch), () => {});
}

function wireView(copy: Copy): WireView {
  return {
    getLocalState: () =>
      (copy.presence.store.get(copy.presence.peers.clientID) as PeerState | undefined) ?? null,
  };
}

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
