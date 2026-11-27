import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import type { UploadIntakeResult } from "@meridian/contracts/protocol";
import { type Editor, Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { type UploadWatch, uploads } from "@/core/uploads/upload-store";

export const FILE_DROP_NAME = "meridianFileDrop";

export type FileDropHost = {
  hostDocumentId: string;
  scheme: ContextUriScheme;
  /**
   * Reserves the upload on the server. It resolves before the chip is inserted, so no tab can ask
   * about a file the server has not heard of, with the name the file would take in `assets/` now
   * (`notes (2).zip` beside a `notes.zip`); a refusal (a name, a size) rejects with the message to
   * show, and no chip stands.
   */
  reserve(input: { documentId: string; file: File }): Promise<string>;
  send(input: {
    documentId: string;
    file: File;
    signal: AbortSignal;
    onProgress: (percent: number | null) => void;
  }): Promise<UploadIntakeResult>;
};

type FileDropStorage = {
  host: FileDropHost | null;
  /**
   * The store's view of this text, for as long as the editor lives. Not the host's: a tab the
   * writer switched away from keeps its editor warm with no host, and its undo can still bring a
   * chip back, so the store must not read it as closed.
   */
  watch: { holder: string; watch: UploadWatch } | null;
};

declare module "@tiptap/core" {
  interface Storage {
    meridianFileDrop: FileDropStorage;
  }
}

function linkedDocuments(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    for (const mark of node.marks) {
      const ref = mark.type.name === "link" ? mark.attrs.ref : null;
      if (typeof ref === "string" && ref.startsWith("doc:")) ids.add(ref.slice(4));
    }
  });
  return ids;
}

export function fileDropHost(editor: Editor): FileDropHost | null {
  return editor.storage[FILE_DROP_NAME]?.host ?? null;
}

export function registerFileDropHost(editor: Editor, host: FileDropHost): () => void {
  const storage = editor.storage[FILE_DROP_NAME];
  if (!storage) return () => {};
  storage.host = host;
  if (storage.watch?.holder !== host.hostDocumentId) {
    storage.watch?.watch.release();
    storage.watch = {
      holder: host.hostDocumentId,
      watch: uploads.watch(host.hostDocumentId, () =>
        editor.isDestroyed ? new Set() : linkedDocuments(editor.state.doc),
      ),
    };
  }
  return () => {
    if (storage.host === host) storage.host = null;
  };
}

export const FileDropExtension = Extension.create({
  name: FILE_DROP_NAME,

  addStorage(): FileDropStorage {
    return { host: null, watch: null };
  },

  onDestroy() {
    this.storage.watch?.watch.release();
    this.storage.watch = null;
    this.storage.host = null;
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: new PluginKey("fileDropWatch"),
        view: () => ({
          update(view, previous) {
            if (view.state.doc !== previous.doc) storage.watch?.watch.changed();
          },
        }),
      }),
    ];
  },
});
