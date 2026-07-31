// @vitest-environment jsdom
/**
 * The attachment lifecycle, against a real (headless) TipTap editor and a
 * fake wire. What these hold down is the ratified model: paste-time upload
 * with a pending token at the caret, the server's allocated name adopted
 * into the token's spelling, detach deleting only this draft's own
 * never-sent upload, a sent message freezing its uploads forever, and a
 * failed upload staying — loudly retriable — instead of vanishing.
 */
import type { ThreadUploadDocumentItem } from "@meridian/contracts/protocol";
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ComposerAttachments,
  composerUploadTokens,
  createComposerAttachments,
} from "./composer-attachments";
import { createComposerExtensions } from "./composer-extensions";
import { composerImageBlocks, serializeComposerText } from "./composer-serialization";

const live: Editor[] = [];

beforeEach(() => {
  // jsdom has no object-URL store; the engine only threads the string through.
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:${crypto.randomUUID()}`),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(() => {
  for (const instance of live.splice(0)) instance.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function uploadItem(overrides: Partial<ThreadUploadDocumentItem> = {}): ThreadUploadDocumentItem {
  return {
    threadId: "thread-1",
    documentId: "document-1",
    relationship: "editing",
    name: "fight",
    extension: "png",
    sizeBytes: 3,
    editable: false,
    filetype: null,
    schemaType: null,
    fileType: "image",
    mimeType: "image/png",
    kind: "binary",
    firstTouchedAt: "2026-07-31T00:00:00Z",
    lastTouchedAt: "2026-07-31T00:00:00Z",
    updatedAt: "2026-07-31T00:00:00Z",
    ...overrides,
  };
}

type Deferred = {
  resolve: (item: ThreadUploadDocumentItem) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
};

function mount(options: { abortRejects?: boolean } = {}) {
  const abortRejects = options.abortRejects ?? true;
  const editor = new Editor({
    extensions: createComposerExtensions({ catalog: () => null, placeholder: () => "" }),
  });
  live.push(editor);

  const pending: Deferred[] = [];
  const removed: Array<{ threadId: string; documentId: string }> = [];
  const attachments: ComposerAttachments = createComposerAttachments({
    threadId: () => "thread-1",
    api: {
      upload: ({ signal }) =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject, signal });
          if (abortRejects) {
            signal?.addEventListener("abort", () => reject(new DOMException("gone", "AbortError")));
          }
        }),
      remove: async (threadId, documentId) => {
        removed.push({ threadId, documentId });
      },
    },
  });
  // The composer runs the doc diff on every update; the harness mirrors it.
  editor.on("update", () => attachments.handleDocChange(editor));
  return { editor, attachments, pending, removed };
}

const file = (name = "fight.png", type = "image/png") => new File(["png"], name, { type });

const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

function deleteToken(editor: Editor, uploadId: string) {
  editor.state.doc.descendants((node, pos) => {
    if (node.attrs.upload?.id === uploadId) {
      editor.commands.deleteRange({ from: pos, to: pos + node.nodeSize });
      return false;
    }
    return true;
  });
}

describe("paste-time upload", () => {
  it("lands a pending token at the caret; the chip row is that token", () => {
    const { editor, attachments } = mount();
    expect(attachments.attachFiles(editor, [file()])).toBe(true);

    const tokens = composerUploadTokens(editor.state.doc);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.upload.state).toBe("uploading");
    expect(tokens[0]?.documentId).toBe("");
    expect(serializeComposerText(editor.state.doc)).toBe("[fight.png](uploads://fight.png) ");
    // Pending uploads never ride as image blocks; submit awaits them first.
    expect(composerImageBlocks(editor.state.doc)).toEqual([]);
  });

  it("adopts the server-allocated name into uri, spelling, and label", async () => {
    const { editor, attachments, pending } = mount();
    attachments.attachFiles(editor, [file()]);
    pending[0]?.resolve(uploadItem({ name: "fight-2", extension: "png" }));
    await attachments.settle();

    const [token] = composerUploadTokens(editor.state.doc);
    expect(token?.upload.state).toBe("ready");
    expect(token?.documentId).toBe("document-1");
    expect(token?.uri).toBe("uploads://fight-2.png");
    expect(token?.spelling).toBe("[fight-2.png](uploads://fight-2.png)");
    expect(serializeComposerText(editor.state.doc)).toBe("[fight-2.png](uploads://fight-2.png) ");
    expect(composerImageBlocks(editor.state.doc)).toEqual([
      { type: "image", documentId: "document-1", uri: "uploads://fight-2.png" },
    ]);
  });

  it("keeps a non-image upload designation-only: no image block, ever", async () => {
    const { editor, attachments, pending } = mount();
    attachments.attachFiles(editor, [file("outline.docx", "application/vnd.ms-word")]);
    pending[0]?.resolve(
      uploadItem({ name: "outline", extension: "docx", fileType: "docx", mimeType: null }),
    );
    await attachments.settle();

    expect(composerUploadTokens(editor.state.doc)[0]?.upload.state).toBe("ready");
    expect(composerImageBlocks(editor.state.doc)).toEqual([]);
  });
});

describe("detach and its delete-draft-own half", () => {
  it("deleting a ready draft-created token also deletes the upload", async () => {
    const { editor, attachments, pending, removed } = mount();
    attachments.attachFiles(editor, [file()]);
    pending[0]?.resolve(uploadItem());
    await attachments.settle();

    const [token] = composerUploadTokens(editor.state.doc);
    const previewUrl = token?.upload.previewUrl;
    deleteToken(editor, token?.upload.id ?? "");
    await drain();

    expect(composerUploadTokens(editor.state.doc)).toEqual([]);
    expect(removed).toEqual([{ threadId: "thread-1", documentId: "document-1" }]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(previewUrl);

    // Once server cleanup finishes, no retained entry can accidentally retry.
    attachments.retry(editor, token?.upload.id ?? "");
    expect(pending).toHaveLength(1);
  });

  it("never deletes an upload a sent turn references", async () => {
    const { editor, attachments, pending, removed } = mount();
    attachments.attachFiles(editor, [file()]);
    pending[0]?.resolve(uploadItem());
    await attachments.settle();

    const [token] = composerUploadTokens(editor.state.doc);
    const previewUrl = token?.upload.previewUrl;
    attachments.markSent(editor.state.doc);
    // Sending is terminal immediately; the subsequent draft clear has no
    // lifecycle work left and the original File is no longer retained.
    attachments.retry(editor, token?.upload.id ?? "");
    expect(pending).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(previewUrl);
    editor.commands.clearContent();
    await drain();

    expect(removed).toEqual([]);
  });

  it("a token detached mid-flight aborts the request, deleting nothing", async () => {
    const { editor, attachments, pending, removed } = mount();
    attachments.attachFiles(editor, [file()]);
    const [token] = composerUploadTokens(editor.state.doc);
    deleteToken(editor, token?.upload.id ?? "");

    expect(pending[0]?.signal?.aborted).toBe(true);
    await attachments.settle();
    expect(removed).toEqual([]);
    attachments.retry(editor, token?.upload.id ?? "");
    expect(pending).toHaveLength(1);
  });

  it("an upload that lands after its token was detached gets deleted", async () => {
    // The abort lost the race: the server already imported the file, so the
    // writer's "not this file" finishes as a delete.
    const { editor, attachments, pending, removed } = mount({ abortRejects: false });
    attachments.attachFiles(editor, [file()]);
    const [token] = composerUploadTokens(editor.state.doc);
    deleteToken(editor, token?.upload.id ?? "");
    pending[0]?.resolve(uploadItem({ documentId: "document-9" }));
    await attachments.settle();
    await drain();

    expect(removed).toEqual([{ threadId: "thread-1", documentId: "document-9" }]);
    attachments.retry(editor, token?.upload.id ?? "");
    expect(pending).toHaveLength(1);
  });
});

describe("failure stays loud", () => {
  it("a failed upload keeps its token, marked failed, and retry re-runs it", async () => {
    const { editor, attachments, pending } = mount();
    attachments.attachFiles(editor, [file()]);
    pending[0]?.reject(new Error("network down"));
    await attachments.settle();

    const [token] = composerUploadTokens(editor.state.doc);
    expect(token?.upload.state).toBe("failed");

    attachments.retry(editor, token?.upload.id ?? "");
    expect(composerUploadTokens(editor.state.doc)[0]?.upload.state).toBe("uploading");
    pending[1]?.resolve(uploadItem());
    await attachments.settle();
    expect(composerUploadTokens(editor.state.doc)[0]?.upload.state).toBe("ready");
  });

  it("forgets a failed upload only after the writer removes its token", async () => {
    const { editor, attachments, pending } = mount();
    attachments.attachFiles(editor, [file()]);
    pending[0]?.reject(new Error("network down"));
    await attachments.settle();

    const [token] = composerUploadTokens(editor.state.doc);
    const previewUrl = token?.upload.previewUrl;
    // Failure itself remains retriable and therefore retained.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    deleteToken(editor, token?.upload.id ?? "");

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(previewUrl);
    attachments.retry(editor, token?.upload.id ?? "");
    expect(pending).toHaveLength(1);
  });
});
