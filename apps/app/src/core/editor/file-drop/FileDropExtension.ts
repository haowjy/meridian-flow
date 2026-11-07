/**
 * FileDropExtension — where a dropped file's bytes go.
 *
 * The app registers one host per mounted editor (`registerFileDropHost`): the source `assets/` is
 * in, and how to send a file there. The door (`file-drop-door.ts`) starts uploads through it into
 * the upload store (`core/uploads/upload-store.ts`), which the chips draw from and which decides
 * when the writer has taken one back. This file tells the store which uploads the document's text
 * still links to.
 */

import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import type { UploadIntakeResult } from "@meridian/contracts/protocol";
import { type Editor, Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { type UploadWatch, uploads } from "@/core/uploads/upload-store";

export const FILE_DROP_NAME = "meridianFileDrop";

export type FileDropHost = {
  /** The document whose text holds the chips: the uploads' holder, which outlives this editor. */
  hostDocumentId: string;
  /** The source of that document: a dropped file lands in its `assets/`. */
  scheme: ContextUriScheme;
  /**
   * Reserves the upload on the server. It resolves before the chip is inserted, so no tab can ask
   * about a file the server has not heard of; a refusal (a name, a size) rejects with the message
   * to show, and no chip stands.
   */
  reserve(input: { documentId: string; file: File }): Promise<void>;
  /** Sends the bytes and finishes; calling again resumes. */
  send(input: {
    documentId: string;
    file: File;
    signal: AbortSignal;
    onProgress: (percent: number | null) => void;
  }): Promise<UploadIntakeResult>;
};

type FileDropStorage = { host: FileDropHost | null; watch: UploadWatch | null };

declare module "@tiptap/core" {
  interface Storage {
    meridianFileDrop: FileDropStorage;
  }
}

/** The documents this text links to by `doc:` ref. */
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

/** The host registered on this editor, or null where files cannot be dropped. */
export function fileDropHost(editor: Editor): FileDropHost | null {
  return editor.storage[FILE_DROP_NAME]?.host ?? null;
}

/** Registers the app's half; returns the release. */
export function registerFileDropHost(editor: Editor, host: FileDropHost): () => void {
  const storage = editor.storage[FILE_DROP_NAME];
  if (!storage) return () => {};
  storage.watch?.release();
  storage.host = host;
  const watch = uploads.watch(host.hostDocumentId, () =>
    editor.isDestroyed ? new Set() : linkedDocuments(editor.state.doc),
  );
  storage.watch = watch;
  return () => {
    watch.release();
    if (storage.host !== host) return;
    storage.host = null;
    storage.watch = null;
  };
}

export const FileDropExtension = Extension.create({
  name: FILE_DROP_NAME,

  addStorage(): FileDropStorage {
    return { host: null, watch: null };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: new PluginKey("fileDropWatch"),
        view: () => ({
          update(view, previous) {
            if (view.state.doc !== previous.doc) storage.watch?.changed();
          },
        }),
      }),
    ];
  },
});
