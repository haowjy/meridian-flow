/**
 * Paste-time upload lifecycle for composer attachments.
 *
 * The token is the attachment; this engine is only its transport. A pasted
 * file lands as an atomic `referenceToken` (kind `"upload"`) at the caret and
 * the upload starts immediately — the ruled paste-time model. Everything a
 * chip can show lives in the token's attrs; what lives here is what attrs
 * cannot hold: the `File` (for retry), the request handle (for abort), and
 * the two facts detach semantics turn on — did this draft create the upload,
 * and has a sent turn claimed it.
 *
 * Detach is one operation with two doors: backspacing the token and a chip's
 * × both remove the node, and `handleDocChange` (the doc diff run on every
 * update) is the single place removal is noticed. Removing a draft-created,
 * never-sent upload also deletes it server-side (ratified decision 4);
 * `markSent` at submit is what flips uploads out of the deletable set before
 * the composer clears. `@`-picked tokens are a different kind entirely and
 * this engine never touches them.
 *
 * Failure never drops silently: a failed upload stays a token (chip shows
 * retry and ×), and the composer refuses to send past it until the writer
 * resolves it — the one ratified hold.
 */

import type { ThreadUploadDocumentItem } from "@meridian/contracts/protocol";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

import { deleteThreadUploadDocument, uploadThreadDocument } from "@/client/api/threads-api";

import {
  composerReferenceTokens,
  REFERENCE_TOKEN_NODE,
  type ReferenceTokenAttributes,
  type ReferenceTokenUpload,
} from "./reference-token";

/** An upload token, with the lifecycle attrs guaranteed present. */
export type ComposerUploadToken = ReferenceTokenAttributes & { upload: ReferenceTokenUpload };

/** The draft's upload tokens, in document order — what the chip row renders. */
export function composerUploadTokens(doc: PMNode): ComposerUploadToken[] {
  return composerReferenceTokens(doc).filter(isUploadToken);
}

function isUploadToken(token: ReferenceTokenAttributes): token is ComposerUploadToken {
  return token.kind === "upload" && token.upload !== null;
}

export type ComposerAttachmentsApi = {
  upload: (input: {
    threadId: string;
    file: File;
    signal?: AbortSignal;
  }) => Promise<ThreadUploadDocumentItem>;
  remove: (threadId: string, documentId: string) => Promise<void>;
};

export type ComposerAttachmentsOptions = {
  /** Read per call: the surface's live thread, or null where none exists (Home hero). */
  threadId: () => string | null;
  /** Fires after the server's upload set changed (import or delete) so rails can refetch. */
  onUploadsChanged?: (threadId: string) => void;
  /** Injectable for tests; defaults to the real thread routes. */
  api?: ComposerAttachmentsApi;
};

export type ComposerAttachments = {
  /** False where no thread exists to attach to (paste stays plain). */
  canAttach(): boolean;
  /**
   * Insert one pending token per file (at `at`, or the caret) and start their
   * uploads. Returns false when there is nothing to do (no files, no thread).
   */
  attachFiles(editor: Editor, files: readonly File[], at?: number): boolean;
  /** Remove the token — the chip ×. The doc diff handles the rest. */
  detach(editor: Editor, uploadId: string): void;
  /** Re-run a failed upload with the kept bytes. */
  retry(editor: Editor, uploadId: string): void;
  /** Run on every editor update: notices removed tokens and settles them. */
  handleDocChange(editor: Editor): void;
  /** Resolves when no upload is in flight — how submit awaits quietly. */
  settle(): Promise<void>;
  /**
   * The message is sending: everything currently in the doc rode a turn, so
   * the clear that follows must not read as detach-and-delete.
   */
  markSent(doc: PMNode): void;
  /** Release object URLs. In-flight uploads finish (abandoned files persist visibly). */
  dispose(): void;
};

type UploadEntry = {
  uploadId: string;
  threadId: string;
  file: File;
  objectUrl: string | null;
  status: "uploading" | "ready" | "failed";
  documentId: string | null;
  /** Settles (never rejects) when the current attempt finishes either way. */
  attempt: Promise<void>;
  abort: AbortController;
  /** The token left the doc; a still-flying request resolves into a delete. */
  detached: boolean;
  /** A sent turn references this upload — never delete it on later removal. */
  sent: boolean;
};

const defaultApi: ComposerAttachmentsApi = {
  upload: uploadThreadDocument,
  remove: deleteThreadUploadDocument,
};

export function createComposerAttachments(
  options: ComposerAttachmentsOptions,
): ComposerAttachments {
  const api = options.api ?? defaultApi;
  const entries = new Map<string, UploadEntry>();

  function pendingAttributes(entry: UploadEntry): ReferenceTokenAttributes {
    // The filename is provisional until the server allocates the real one
    // (collisions suffix to name-2.ext); submit awaits resolution, so this
    // spelling is never what a message actually carries.
    const uri = `uploads://${entry.file.name}`;
    return {
      kind: "upload",
      documentId: "",
      uri,
      label: entry.file.name,
      spelling: `[${entry.file.name}](${uri})`,
      upload: {
        id: entry.uploadId,
        state: "uploading",
        mimeType: entry.file.type,
        previewUrl: entry.objectUrl ?? "",
        sizeBytes: entry.file.size,
      },
    };
  }

  function findToken(editor: Editor, uploadId: string): { node: PMNode; pos: number } | null {
    let found: { node: PMNode; pos: number } | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (found) return false;
      if (node.type.name === REFERENCE_TOKEN_NODE && node.attrs.upload?.id === uploadId) {
        found = { node, pos };
        return false;
      }
      return true;
    });
    return found;
  }

  /** Attr patches ride outside history: undo must never resurrect "uploading". */
  function patchToken(
    editor: Editor,
    uploadId: string,
    attrs: Partial<ReferenceTokenAttributes>,
    upload: Partial<ReferenceTokenUpload>,
  ): void {
    if (editor.isDestroyed) return;
    const found = findToken(editor, uploadId);
    if (!found) return;
    const previous = found.node.attrs as ReferenceTokenAttributes;
    const tr = editor.state.tr.setNodeMarkup(found.pos, undefined, {
      ...previous,
      ...attrs,
      upload: previous.upload ? { ...previous.upload, ...upload } : previous.upload,
    });
    tr.setMeta("addToHistory", false);
    editor.view.dispatch(tr);
  }

  async function removeQuietly(entry: UploadEntry): Promise<void> {
    if (!entry.documentId) return;
    try {
      await api.remove(entry.threadId, entry.documentId);
      options.onUploadsChanged?.(entry.threadId);
    } catch {
      // The file outlives the gesture and stays visible in the rail, where
      // delete already exists — never a blocking error for a detach.
    }
  }

  function start(editor: Editor, entry: UploadEntry): void {
    entry.status = "uploading";
    entry.attempt = (async () => {
      try {
        const item = await api.upload({
          threadId: entry.threadId,
          file: entry.file,
          signal: entry.abort.signal,
        });
        entry.status = "ready";
        entry.documentId = item.documentId;
        if (entry.detached && !entry.sent) {
          // Detached while the bytes were still in flight: the writer already
          // said "not this file", so finish the gesture they made.
          await removeQuietly(entry);
          return;
        }
        // The server owns the final name (collision suffixing); the token's
        // wire spelling adopts it so the link names the file that exists.
        const filename = item.extension ? `${item.name}.${item.extension}` : item.name;
        const uri = `uploads://${filename}`;
        patchToken(
          editor,
          entry.uploadId,
          { documentId: item.documentId, uri, label: filename, spelling: `[${filename}](${uri})` },
          { state: "ready" },
        );
        options.onUploadsChanged?.(entry.threadId);
      } catch {
        entry.status = "failed";
        if (entry.detached) return;
        patchToken(editor, entry.uploadId, {}, { state: "failed" });
      }
    })();
  }

  return {
    canAttach() {
      return options.threadId() !== null;
    },

    attachFiles(editor, files, at) {
      const threadId = options.threadId();
      if (!threadId || files.length === 0 || editor.isDestroyed) return false;
      const created: UploadEntry[] = [];
      const content: Array<{ type: string; attrs?: ReferenceTokenAttributes; text?: string }> = [];
      for (const file of files) {
        const entry: UploadEntry = {
          uploadId: crypto.randomUUID(),
          threadId,
          file,
          objectUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
          status: "uploading",
          documentId: null,
          attempt: Promise.resolve(),
          abort: new AbortController(),
          detached: false,
          sent: false,
        };
        entries.set(entry.uploadId, entry);
        created.push(entry);
        // A trailing space after each token, like a pick: the caret should
        // land ready for prose, not pressed against a pill.
        content.push({ type: REFERENCE_TOKEN_NODE, attrs: pendingAttributes(entry) });
        content.push({ type: "text", text: " " });
      }
      const chain = editor.chain().focus();
      (at != null ? chain.insertContentAt(at, content) : chain.insertContent(content)).run();
      for (const entry of created) start(editor, entry);
      return true;
    },

    detach(editor, uploadId) {
      if (editor.isDestroyed) return;
      const found = findToken(editor, uploadId);
      if (!found) return;
      editor
        .chain()
        .focus()
        .deleteRange({ from: found.pos, to: found.pos + found.node.nodeSize })
        .run();
    },

    retry(editor, uploadId) {
      const entry = entries.get(uploadId);
      if (!entry || entry.status === "uploading" || editor.isDestroyed) return;
      entry.detached = false;
      entry.abort = new AbortController();
      if (!entry.objectUrl && entry.file.type.startsWith("image/")) {
        entry.objectUrl = URL.createObjectURL(entry.file);
      }
      patchToken(editor, uploadId, {}, { state: "uploading", previewUrl: entry.objectUrl ?? "" });
      start(editor, entry);
    },

    handleDocChange(editor) {
      if (editor.isDestroyed) return;
      const present = new Set(
        composerUploadTokens(editor.state.doc).map((token) => token.upload.id),
      );
      for (const entry of entries.values()) {
        if (entry.detached || present.has(entry.uploadId)) continue;
        entry.detached = true;
        if (entry.objectUrl) {
          URL.revokeObjectURL(entry.objectUrl);
          entry.objectUrl = null;
        }
        if (entry.sent) continue;
        if (entry.status === "uploading") {
          // The attempt's own resolution decides: abort usually wins, but a
          // request that already landed resolves into the delete instead.
          entry.abort.abort();
          continue;
        }
        if (entry.status === "ready") void removeQuietly(entry);
        // Failed uploads created nothing server-side; dropping the token is all.
      }
    },

    async settle() {
      // A retry during the wait re-enters the in-flight set; loop until quiet.
      for (;;) {
        const inFlight = [...entries.values()]
          .filter((entry) => entry.status === "uploading")
          .map((entry) => entry.attempt);
        if (inFlight.length === 0) return;
        await Promise.allSettled(inFlight);
      }
    },

    markSent(doc) {
      for (const token of composerUploadTokens(doc)) {
        const entry = entries.get(token.upload.id);
        if (entry) entry.sent = true;
      }
    },

    dispose() {
      for (const entry of entries.values()) {
        if (entry.objectUrl) {
          URL.revokeObjectURL(entry.objectUrl);
          entry.objectUrl = null;
        }
      }
    },
  };
}

/** Files on a clipboard or drag payload; empty when the payload is text-only. */
export function attachableFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...data.files];
}
