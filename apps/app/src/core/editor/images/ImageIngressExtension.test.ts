// @vitest-environment jsdom
/**
 * The pending picture is a document fact.
 *
 * Every case here is a claim about the DOCUMENT while bytes are in flight — the
 * claim the old shell-level upload status could not make. The upload port is
 * held open deliberately: what the writer can see and do mid-upload is the
 * whole subject, so nothing may depend on it having finished.
 *
 * A real Yjs pair rather than a bare editor, because a pending slot has to
 * survive a peer's write: y-prosemirror rebuilds the whole document and reports
 * every position deleted, which is exactly the hazard the anchored hold exists
 * for.
 */
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";

// jsdom ships no `ClipboardEvent`, and ProseMirror's own `pasteHTML` builds one
// when it is not handed an event. The browser has it; the harness does not.
if (typeof globalThis.ClipboardEvent === "undefined") {
  class StubClipboardEvent extends Event {}
  Object.defineProperty(globalThis, "ClipboardEvent", { value: StubClipboardEvent });
}

import type { ImageUploadPort, UploadedImage } from "./image-ingress-ports";
import { pendingImages, registerImageIngressHost } from "./image-ingress-runtime";
import { insertImageFile, removePendingImage, retryPendingImage } from "./image-uploads";
import type { PendingImage } from "./pending-images";

type HeldUpload = {
  file: File;
  alt: string;
  signal: AbortSignal;
  progress: (percent: number | null) => void;
  settle: (uploaded: UploadedImage) => void;
  fail: (reason: Error) => void;
};

/** An upload that never finishes on its own: the test decides when it does. */
function heldUploadPort(): { port: ImageUploadPort; held: HeldUpload[] } {
  const held: HeldUpload[] = [];
  const port: ImageUploadPort = ({ file, alt, signal, onProgress }) =>
    new Promise<UploadedImage>((resolve, reject) => {
      held.push({
        file,
        alt,
        signal,
        progress: onProgress,
        settle: resolve,
        fail: reject,
      });
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  return { port, held };
}

function asset(id: string): UploadedImage {
  return {
    src: `asset:${id}`,
    alt: "Cover art",
    assetDocumentId: id,
    assetPath: `assets/${id}.png`,
  };
}

function imageFile(name = "cover art.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

/** Lets the plugin's end-of-task settling (orphan sweep, paste imports) run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function imageNodes(editor: Editor): { pos: number; src: string; alt: string | null }[] {
  const found: { pos: number; src: string; alt: string | null }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "image") {
      found.push({
        pos,
        src: String(node.attrs.src ?? ""),
        alt: node.attrs.alt === null ? null : String(node.attrs.alt),
      });
    }
    return true;
  });
  return found;
}

let pair: CollabPair | null = null;

afterEach(() => {
  pair?.destroy();
  pair = null;
});

function mount(text = "The gate opened."): {
  editor: Editor;
  peer: Editor;
  sync: () => void;
  held: HeldUpload[];
  bytes: { calls: string[]; settle: (url: string, file: File | null) => void };
} {
  pair = createCollabPair({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  const { port, held } = heldUploadPort();
  const waiting = new Map<string, (file: File | null) => void>();
  const calls: string[] = [];
  registerImageIngressHost(pair.local, {
    upload: port,
    fetchBytes: ({ url }: { url: string }) => {
      calls.push(url);
      return new Promise((resolve) => waiting.set(url, resolve));
    },
  });
  return {
    editor: pair.local,
    peer: pair.peer,
    sync: pair.sync,
    held,
    bytes: {
      calls,
      settle: (url, file) => waiting.get(url)?.(file),
    },
  };
}

describe("a picture in flight occupies its final slot", () => {
  it("puts the image node in the document before the upload finishes", async () => {
    const { editor, held } = mount();
    editor.commands.setTextSelection(5);

    insertImageFile(editor, imageFile(), 5);
    await settle();

    expect(held).toHaveLength(1);
    expect(imageNodes(editor)).toEqual([{ pos: 5, src: "", alt: "cover art" }]);
    expect(pendingImages(editor)).toMatchObject([
      { kind: "upload", filename: "cover art.png", status: { kind: "uploading", percent: null } },
    ]);
  });

  it("reports progress against that node without touching the document", async () => {
    const { editor, held } = mount();
    insertImageFile(editor, imageFile(), 5);
    await settle();
    const beforeProgress = editor.state.doc.toJSON();

    held[0].progress(42);
    await settle();

    expect(pendingImages(editor)).toMatchObject([{ status: { kind: "uploading", percent: 42 } }]);
    expect(editor.state.doc.toJSON()).toEqual(beforeProgress);
  });

  it("lands the picture in the slot it already had, changing nothing else", async () => {
    const { editor, held } = mount();
    insertImageFile(editor, imageFile(), 5);
    await settle();
    const pendingDoc = editor.state.doc.toJSON();

    held[0].settle(asset("asset-1"));
    await settle();

    expect(imageNodes(editor)).toEqual([{ pos: 5, src: "asset:asset-1", alt: "Cover art" }]);
    expect(pendingImages(editor)).toEqual([]);
    // Same shape, same slot: only the picture's own source changed, which is
    // what makes completion cost the manuscript no layout.
    const landed = editor.state.doc.toJSON();
    expect(withoutImageSrc(landed)).toEqual(withoutImageSrc(pendingDoc));
  });

  it("keeps the slot and offers Retry after a failure", async () => {
    const { editor, held } = mount();
    insertImageFile(editor, imageFile(), 5);
    await settle();

    held[0].fail(new Error("The connection dropped."));
    await settle();

    expect(imageNodes(editor)).toEqual([{ pos: 5, src: "", alt: "cover art" }]);
    expect(pendingImages(editor)).toMatchObject([
      { status: { kind: "failed", message: "The connection dropped." } },
    ]);

    retryPendingImage(editor, 5);
    await settle();
    expect(held).toHaveLength(2);
    expect(pendingImages(editor)).toMatchObject([{ status: { kind: "uploading" } }]);
  });

  it("survives a peer's write, which replaces the whole document", async () => {
    const { editor, peer, sync, held } = mount();
    insertImageFile(editor, imageFile(), 5);
    await settle();
    sync();

    peer.commands.insertContentAt(1, "Later that night, ");
    sync();
    await settle();

    const moved = imageNodes(editor);
    expect(moved).toHaveLength(1);
    expect(moved[0].pos).toBeGreaterThan(5);
    expect(pendingImages(editor)).toHaveLength(1);

    held[0].settle(asset("asset-2"));
    await settle();
    expect(imageNodes(editor)).toEqual([
      { pos: moved[0].pos, src: "asset:asset-2", alt: "Cover art" },
    ]);
  });
});

describe("the writer owns a picture in flight", () => {
  it("aborts the upload when the pending node is deleted", async () => {
    const { editor, held } = mount();
    insertImageFile(editor, imageFile(), 5);
    await settle();

    editor.view.dispatch(editor.state.tr.delete(5, 6));
    await settle();

    expect(held[0].signal.aborted).toBe(true);
    expect(pendingImages(editor)).toEqual([]);
    expect(imageNodes(editor)).toEqual([]);
  });

  it("aborts when Remove takes the failed picture out", async () => {
    const { editor, held } = mount();
    insertImageFile(editor, imageFile(), 5);
    await settle();
    held[0].fail(new Error("Storage said no."));
    await settle();

    removePendingImage(editor, 5);
    await settle();

    expect(held[0].signal.aborted).toBe(true);
    expect(pendingImages(editor)).toEqual([]);
    expect(imageNodes(editor)).toEqual([]);
  });

  it("does not write a picture into a slot the writer took back", async () => {
    const { editor, held } = mount();
    insertImageFile(editor, imageFile(), 5);
    await settle();
    editor.view.dispatch(editor.state.tr.delete(5, 6));
    await settle();

    held[0].settle(asset("asset-3"));
    await settle();

    expect(imageNodes(editor)).toEqual([]);
  });

  it("keeps typing possible around the pending picture", async () => {
    const { editor } = mount();
    insertImageFile(editor, imageFile(), 5);
    await settle();

    editor.commands.insertContentAt(1, "Then ");
    await settle();

    expect(editor.state.doc.textContent).toBe("Then The gate opened.");
    expect(pendingImages(editor)).toHaveLength(1);
    expect(imageNodes(editor)).toEqual([{ pos: 10, src: "", alt: "cover art" }]);
  });
});

describe("two pictures arriving together are two lifecycles", () => {
  it("tracks concurrent uploads independently", async () => {
    const { editor, held } = mount();
    insertImageFile(editor, imageFile("first.png"), 5);
    await settle();
    insertImageFile(editor, imageFile("second.png"), 1);
    await settle();

    expect(pendingImages(editor).map((entry: PendingImage) => entry.filename)).toEqual([
      "first.png",
      "second.png",
    ]);

    held[0].progress(70);
    held[1].fail(new Error("second.png was refused."));
    await settle();

    expect(pendingImages(editor)).toMatchObject([
      { filename: "first.png", status: { kind: "uploading", percent: 70 } },
      { filename: "second.png", status: { kind: "failed", message: "second.png was refused." } },
    ]);
  });

  it("imports two pasted addresses independently", async () => {
    const { editor, bytes, held } = mount();
    editor.view.pasteHTML(
      '<p><img src="https://example.test/one.png" alt="One"> and <img src="https://example.test/two.png" alt="Two"></p>',
    );
    await settle();

    // Neither address is in the document: a paste lands the link, never a `src`
    // the project does not own.
    expect(imageNodes(editor)).toEqual([]);
    expect(bytes.calls).toEqual(["https://example.test/one.png", "https://example.test/two.png"]);
    expect(pendingImages(editor).map((entry: PendingImage) => entry.kind)).toEqual([
      "import",
      "import",
    ]);

    // One site hands over its bytes; the other refuses. The refusal must not
    // touch the import that is still working.
    bytes.settle("https://example.test/two.png", null);
    await settle();
    expect(pendingImages(editor).map((entry: PendingImage) => entry.kind)).toEqual(["import"]);

    bytes.settle("https://example.test/one.png", imageFile("one.png"));
    await settle();
    expect(held).toHaveLength(1);

    held[0].settle(asset("asset-one"));
    await settle();
    expect(imageNodes(editor).map((node) => node.src)).toEqual(["asset:asset-one"]);
    expect(pendingImages(editor)).toEqual([]);
    // The refused one is still the link the paste landed.
    expect(editor.state.doc.textContent).toContain("https://example.test/two.png");
  });
});

/** Everything about the document except which picture the node points at. */
function withoutImageSrc(doc: unknown): unknown {
  if (Array.isArray(doc)) return doc.map(withoutImageSrc);
  if (doc && typeof doc === "object") {
    const entries = Object.entries(doc as Record<string, unknown>).map(([key, value]) =>
      key === "attrs" && (doc as { type?: string }).type === "image"
        ? [key, { ...(value as Record<string, unknown>), src: "<src>", alt: "<alt>" }]
        : [key, withoutImageSrc(value)],
    );
    return Object.fromEntries(entries);
  }
  return doc;
}
