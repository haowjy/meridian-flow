/**
 * FileDropExtension — where a dropped file's bytes go, and who takes the upload back.
 *
 * The app registers one host per mounted editor (`registerFileDropHost`): the
 * source `assets/` is in, and the function that sends a file. The door
 * (`file-drop-door.ts`) starts uploads through it; the chips draw from
 * `link-uploads.ts`. This file also owns the one rule that ends an upload the
 * writer no longer wants: its chip has left the document (undo, delete, a cut
 * that was never pasted back) for long enough that no paste is coming.
 */

import type { ContextUriScheme } from "@meridian/contracts/context-uri";
import { type Editor, Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import { linkUploads, type UploadRun } from "../links/link-uploads";

export const FILE_DROP_NAME = "meridianFileDrop";

export type FileDropHost = {
  /** The document whose text holds the chips: the editor's own, which the sweep reads. */
  hostDocumentId: string;
  /** The source of that document: a dropped file lands in its `assets/`. */
  scheme: ContextUriScheme;
  /**
   * Reserves the upload on the server and answers with the function that sends the bytes. It
   * resolves before the chip is inserted, so no tab can ask about a file the server has not
   * heard of; a refusal (a name, a size) rejects with the message to show, and no chip stands.
   */
  start(input: { documentId: string; file: File }): Promise<UploadRun>;
};

declare module "@tiptap/core" {
  interface Storage {
    meridianFileDrop: { host: FileDropHost | null };
  }
}

/**
 * How long a chip may be out of the document before its upload is taken back.
 * A cut and paste inside one document puts it back within moments; an undo
 * does not.
 */
export const ABSENT_UPLOAD_GRACE_MS = 10_000;
/** Doc changes in a burst cost one scan. */
const SCAN_DEBOUNCE_MS = 1_000;

const docRefs = (doc: PMNode): Set<string> => {
  const refs = new Set<string>();
  doc.descendants((node) => {
    for (const mark of node.marks)
      if (mark.type.name === "link" && mark.attrs.ref) refs.add(mark.attrs.ref);
  });
  return refs;
};

/** The host registered on this editor, or null where files cannot be dropped. */
export function fileDropHost(editor: Editor): FileDropHost | null {
  return editor.storage[FILE_DROP_NAME]?.host ?? null;
}

/** Registers the app's half; returns the release. */
export function registerFileDropHost(editor: Editor, host: FileDropHost): () => void {
  const storage = editor.storage[FILE_DROP_NAME];
  if (!storage) return () => {};
  storage.host = host;
  return () => {
    if (storage.host === host) storage.host = null;
  };
}

export const FileDropExtension = Extension.create({
  name: FILE_DROP_NAME,

  addStorage() {
    return { host: null as FileDropHost | null };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("fileDropSweep"),
        view: () => {
          /** When each upload's chip was first seen missing. */
          const absentSince = new Map<string, number>();
          let timer: ReturnType<typeof setTimeout> | null = null;

          const scan = () => {
            timer = null;
            const host = fileDropHost(editor);
            if (!host || editor.isDestroyed) return;
            const waiting = linkUploads.forHolder(host.hostDocumentId);
            if (waiting.length === 0) {
              absentSince.clear();
              return;
            }
            const refs = docRefs(editor.state.doc);
            const now = Date.now();
            let nextCheck: number | null = null;
            for (const documentId of waiting) {
              if (refs.has(`doc:${documentId}`)) {
                absentSince.delete(documentId);
                continue;
              }
              const since = absentSince.get(documentId) ?? now;
              absentSince.set(documentId, since);
              const left = since + ABSENT_UPLOAD_GRACE_MS - now;
              if (left <= 0) {
                absentSince.delete(documentId);
                linkUploads.cancel(documentId);
              } else nextCheck = Math.min(nextCheck ?? left, left);
            }
            if (nextCheck !== null) timer = setTimeout(scan, nextCheck);
          };
          const schedule = () => {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(scan, SCAN_DEBOUNCE_MS);
          };

          return {
            update(view, previous) {
              if (view.state.doc === previous.doc) return;
              const host = fileDropHost(editor);
              if (host && linkUploads.forHolder(host.hostDocumentId).length > 0) schedule();
            },
            destroy() {
              // The upload outlives the editor that started it; only the watching stops.
              if (timer !== null) clearTimeout(timer);
            },
          };
        },
      }),
    ];
  },
});
