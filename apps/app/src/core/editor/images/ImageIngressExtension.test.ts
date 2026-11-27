// @vitest-environment jsdom
import type { Editor, JSONContent } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it, vi } from "vitest";

import { undoEditorHistory } from "@/core/editor/editor-history";
import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";
import { createStandaloneEditor, requireNode } from "@/test-support/standalone-editor";

// jsdom ships no `ClipboardEvent`, and ProseMirror's own `pasteHTML` builds one
// when it is not handed an event. The browser has it; the harness does not.
if (typeof globalThis.ClipboardEvent === "undefined") {
  class StubClipboardEvent extends Event {}
  Object.defineProperty(globalThis, "ClipboardEvent", { value: StubClipboardEvent });
}

import { uploads } from "@/core/uploads/upload-store";
import type { ImageUploadPort, UploadedImage } from "./image-ingress-ports";
import {
  imageIngressStatus,
  ingressState,
  registerImageIngressHost,
} from "./image-ingress-runtime";
import {
  imageCaretTarget,
  imageReplaceTarget,
  insertImageFile,
  openImagePicker,
  retryPendingImage,
} from "./image-uploads";
import type { PendingImage } from "./pending-images";

function pendingImages(editor: Editor | null): readonly PendingImage[] {
  return Array.from(ingressState(editor).pending.values());
}

function pendingUploads(editor: Editor | null) {
  return pendingImages(editor).map((entry) => ({
    filename: entry.filename,
    status: uploads.read(entry.id),
  }));
}

type HeldUpload = {
  file: File;
  alt: string;
  signal: AbortSignal;
  progress: (percent: number | null) => void;
  settle: (uploaded: UploadedImage) => void;
  fail: (reason: Error) => void;
};

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
  return { src: `asset:${id}`, alt: "Cover art" };
}

function imageFile(name = "cover art.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

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

type Ingress = {
  editor: Editor;
  held: HeldUpload[];
  bytes: {
    calls: string[];
    aborted: string[];
    settle: (url: string, file: File | null) => void;
  };
};

const documentSaying = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

let close: (() => void) | null = null;

afterEach(() => {
  close?.();
  close = null;
});

function mount(document: string | JSONContent = "The gate opened."): Ingress {
  const standalone = createStandaloneEditor({
    content: typeof document === "string" ? documentSaying(document) : document,
  });
  close = standalone.destroy;
  return withHeldPorts(standalone.editor);
}

function mountPair(document: string | JSONContent = "The gate opened."): Ingress & {
  peer: Editor;
  sync: () => void;
  syncAwareness: () => void;
  awareness: CollabPair["awareness"];
  presence: CollabPair["presence"];
} {
  const pair = createCollabPair(typeof document === "string" ? documentSaying(document) : document);
  close = pair.destroy;
  return {
    ...withHeldPorts(pair.local),
    peer: pair.peer,
    sync: pair.sync,
    syncAwareness: pair.syncAwareness,
    awareness: pair.awareness,
    presence: pair.presence,
  };
}

function withHeldPorts(editor: Editor): Ingress {
  const { port, held } = heldUploadPort();
  const waiting = new Map<string, (file: File | null) => void>();
  const calls: string[] = [];
  const aborted: string[] = [];
  registerImageIngressHost(editor, {
    upload: port,
    fetchBytes: ({ url, signal }: { url: string; signal: AbortSignal }) => {
      calls.push(url);
      signal.addEventListener("abort", () => aborted.push(url));
      return new Promise((resolve) => waiting.set(url, resolve));
    },
  });
  return {
    editor,
    held,
    bytes: {
      calls,
      aborted,
      settle: (url, file) => waiting.get(url)?.(file),
    },
  };
}

function slotStatus(editor: Editor, pos: number): string | null {
  const dom = editor.view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom.getAttribute("data-pending-image") : null;
}

function announced(awareness: { getLocalState: () => Record<string, unknown> | null }) {
  return (awareness.getLocalState()?.uploads ?? []) as readonly {
    token: string;
    frame: { width: number; height: number } | null;
  }[];
}

describe("a picture in flight occupies its final slot", () => {
  it("reports progress against that node without touching the document", async () => {
    const { editor, held } = mount();
    insertImageFile(editor, imageFile(), { kind: "inline", pos: 5 });
    await settle();
    const beforeProgress = editor.state.doc.toJSON();

    held[0].progress(42);
    await settle();

    expect(pendingUploads(editor)).toMatchObject([{ status: { kind: "uploading", percent: 42 } }]);
    expect(editor.state.doc.toJSON()).toEqual(beforeProgress);
  });

  it("keeps the slot and offers Retry after a failure", async () => {
    const { editor, held } = mount();
    insertImageFile(editor, imageFile(), { kind: "inline", pos: 5 });
    await settle();

    held[0].fail(new Error("The connection dropped."));
    await settle();

    expect(imageNodes(editor)).toEqual([{ pos: 5, src: "", alt: "cover art" }]);
    expect(pendingUploads(editor)).toMatchObject([
      { status: { kind: "failed", message: "The connection dropped." } },
    ]);

    retryPendingImage(editor, 5);
    await settle();
    expect(held).toHaveLength(2);
    expect(pendingUploads(editor)).toMatchObject([{ status: { kind: "uploading" } }]);
  });

  it("survives a peer's write, which replaces the whole document", async () => {
    const { editor, peer, sync, held } = mountPair();
    insertImageFile(editor, imageFile(), { kind: "inline", pos: 5 });
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
  it("does not write a picture into a slot the writer took back", async () => {
    const { editor, held } = mount();
    insertImageFile(editor, imageFile(), { kind: "inline", pos: 5 });
    await settle();
    editor.view.dispatch(editor.state.tr.delete(5, 6));
    await settle();

    held[0].settle(asset("asset-3"));
    await settle();

    expect(imageNodes(editor)).toEqual([]);
  });
});

describe("two pictures arriving together are two lifecycles", () => {
  it("tracks concurrent uploads independently", async () => {
    const { editor, held } = mount();
    insertImageFile(editor, imageFile("first.png"), { kind: "inline", pos: 5 });
    await settle();
    insertImageFile(editor, imageFile("second.png"), { kind: "inline", pos: 1 });
    await settle();

    expect(pendingImages(editor).map((entry: PendingImage) => entry.filename)).toEqual([
      "first.png",
      "second.png",
    ]);

    held[0].progress(70);
    held[1].fail(new Error("second.png was refused."));
    await settle();

    expect(pendingUploads(editor)).toMatchObject([
      { filename: "first.png", status: { kind: "uploading", percent: 70 } },
      { filename: "second.png", status: { kind: "failed", message: "second.png was refused." } },
    ]);
  });
});

describe("a peer sees an upload it does not own as an upload", () => {
  it("leaves an ownerless empty slot recoverable, not in flight", async () => {
    const { editor, peer, sync } = mountPair();
    editor.commands.insertContentAt(5, { type: "image", attrs: { src: "", alt: "gone" } });
    await settle();
    sync();
    await settle();

    expect(slotStatus(peer, 5)).toBe(null);
  });
});

describe("a pending picture can be moved while its bytes travel", () => {
  it("lands the bytes in the slot the writer moved it to", async () => {
    const { editor, held } = mount();
    insertImageFile(editor, imageFile(), { kind: "inline", pos: 5 });
    await settle();

    const transaction = editor.state.tr;
    const picture = editor.state.doc.nodeAt(5);
    if (!picture) throw new Error("the pending picture is not at 5");
    transaction.delete(5, 6);
    transaction.insert(transaction.doc.content.size - 1, picture);
    editor.view.dispatch(transaction);
    await settle();

    expect(held[0].signal.aborted).toBe(false);
    expect(pendingImages(editor)).toHaveLength(1);
    const moved = imageNodes(editor);
    expect(moved).toHaveLength(1);
    expect(moved[0].pos).toBeGreaterThan(5);

    held[0].settle(asset("asset-moved"));
    await settle();
    expect(imageNodes(editor)).toEqual([
      { pos: moved[0].pos, src: "asset:asset-moved", alt: "Cover art" },
    ]);
  });
});

describe("closing the editor closes what it was carrying", () => {
  it("aborts every upload and releases its owner signal on destroy", async () => {
    const { editor, awareness, held } = mountPair();
    insertImageFile(editor, imageFile(), { kind: "inline", pos: 5 });
    await settle();
    expect(announced(awareness.local)).toEqual([
      { token: pendingImages(editor)[0].id, frame: null },
    ]);

    editor.destroy();

    expect(held[0].signal.aborted).toBe(true);
    expect(announced(awareness.local)).toEqual([]);
  });
});

function openChooser(open: () => void): (file: File) => void {
  const opened: HTMLInputElement[] = [];
  const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
    this: HTMLInputElement,
  ) {
    opened.push(this);
  });
  open();
  click.mockRestore();
  const input = opened[0];
  if (!input) throw new Error("no file chooser opened");
  return (file) => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
  };
}

function peerPictureBlock(editor: Editor) {
  return editor.state.schema.nodes.paragraph.create(null, [
    editor.state.schema.text("abcd"),
    editor.state.schema.nodes.image.create({ src: "asset:peer", alt: "peer" }),
  ]);
}

function documentWithTable(): JSONContent {
  const cell = (text: string): JSONContent => ({
    type: "table_cell",
    attrs: { id: `cell-${text}` },
    content: [{ type: "paragraph", attrs: { id: `p-${text}` }, content: [{ type: "text", text }] }],
  });
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "The gate opened." }] },
      { type: "table", content: [{ type: "table_row", content: [cell("rank"), cell("skill")] }] },
    ],
  };
}

function pictureHome(editor: Editor, alt: string): { text: string; role: unknown } {
  const at = imageNodes(editor).find((node) => node.alt === alt)?.pos;
  if (at === undefined) throw new Error(`no picture called ${alt} in the document`);
  const $at = editor.state.doc.resolve(at);
  return { text: $at.parent.textContent, role: $at.node(-1).type.spec.tableRole };
}

describe("a new picture lands where the writer asked for it", () => {
  it("lands in the cell it was asked from, after the caret moves and a peer writes", async () => {
    const { editor, peer, sync, held } = mountPair(documentWithTable());
    const rank = requireNode(editor, { type: "paragraph", startsWith: "rank" });
    const askedAt = rank.pos + 1 + rank.node.content.size;
    editor.commands.setTextSelection(askedAt);

    const chooseFile = openChooser(() => openImagePicker(editor, imageCaretTarget(editor)));

    editor.commands.setTextSelection(2);
    peer.view.dispatch(peer.state.tr.insert(0, peerPictureBlock(peer)));
    sync();
    await settle();

    chooseFile(imageFile("portrait.png"));
    await settle();

    expect(held).toHaveLength(1);
    expect(pictureHome(editor, "portrait")).toEqual({ text: "rank", role: "cell" });
    expect(editor.state.selection.$from.node(-1).type.spec.tableRole).toBe("cell");
  });

  it("refuses out loud when the place is gone by the time the file comes back", async () => {
    const { editor, peer, sync, held } = mountPair(documentWithTable());
    const rank = requireNode(editor, { type: "paragraph", startsWith: "rank" });
    editor.commands.setTextSelection(rank.pos + 1);
    const table = requireNode(editor, "table");

    const chooseFile = openChooser(() => openImagePicker(editor, imageCaretTarget(editor)));

    peer.view.dispatch(peer.state.tr.delete(table.pos, table.pos + table.node.nodeSize));
    sync();
    editor.commands.setTextSelection(2);
    await settle();

    chooseFile(imageFile("portrait.png"));
    await settle();

    expect(held).toEqual([]);
    expect(imageNodes(editor)).toEqual([]);
    expect(pendingImages(editor)).toEqual([]);
    expect(imageIngressStatus(editor)?.getSnapshot().notice?.message).toBe("Can’t drop here");
  });
});

function tableDocument2x2(): JSONContent {
  const cell = (text: string): JSONContent => ({
    type: "table_cell",
    attrs: { id: `cell-${text}` },
    content: [{ type: "paragraph", attrs: { id: `p-${text}` }, content: [{ type: "text", text }] }],
  });
  return {
    type: "doc",
    content: [
      {
        type: "table",
        attrs: { id: "t" },
        content: [
          { type: "table_row", attrs: { id: "r1" }, content: [cell("a1"), cell("a2")] },
          { type: "table_row", attrs: { id: "r2" }, content: [cell("b1"), cell("b2")] },
        ],
      },
    ],
  };
}

function sweepCells(editor: Editor, anchorIndex: number, headIndex: number): void {
  const cells: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === "cell") cells.push(pos);
    return true;
  });
  const selection = CellSelection.create(editor.state.doc, cells[anchorIndex], cells[headIndex]);
  editor.view.dispatch(editor.state.tr.setSelection(selection));
}

function pasteFile(editor: Editor, file: File): void {
  const event = new ClipboardEvent("paste", { cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      getData: () => "",
    },
  });
  editor.view.dom.dispatchEvent(event);
}

describe("an image file pasted over a sweep replaces the sweep", () => {
  it("is one undo step: the swept cells and their text come back together", async () => {
    const { editor } = mount(tableDocument2x2());
    editor.registerPlugin(history());
    const before = editor.state.doc.toJSON();
    sweepCells(editor, 0, 3);

    pasteFile(editor, imageFile());
    await settle();
    expect(imageNodes(editor)).toHaveLength(1);

    undo(editor.view.state, editor.view.dispatch);
    expect(editor.state.doc.toJSON()).toEqual(before);
  });
});

describe("Replace aims at the picture the writer pointed at", () => {
  it("takes the whole replacement back in one undo", async () => {
    const { editor, held } = mountPair();
    insertImageFile(editor, imageFile(), { kind: "inline", pos: 5 });
    await settle();
    held[0].settle(asset("old"));
    await settle();
    editor.commands.insertContentAt(1, "Then ");
    await settle();

    const chooseFile = openChooser(() =>
      openImagePicker(editor, imageReplaceTarget(editor, imageNodes(editor)[0].pos)),
    );
    chooseFile(imageFile("replacement.png"));
    await settle();
    held[1].settle(asset("new"));
    await settle();
    expect(imageNodes(editor).map((node) => node.src)).toEqual(["asset:new"]);

    expect(undoEditorHistory(editor)).toBe(true);
    await settle();

    expect(imageNodes(editor).map((node) => node.src)).toEqual(["asset:old"]);
    expect(editor.state.doc.textContent).toBe("Then The gate opened.");
  });

  it("still undoes an inserted picture away, bytes and all", async () => {
    const { editor, held } = mountPair();
    insertImageFile(editor, imageFile(), { kind: "inline", pos: 5 });
    await settle();
    held[0].settle(asset("only"));
    await settle();

    expect(undoEditorHistory(editor)).toBe(true);
    await settle();

    expect(imageNodes(editor)).toEqual([]);
    expect(editor.state.doc.textContent).toBe("The gate opened.");
  });
});

describe("an announcement made while the writer is hidden is still true after", () => {
  it("releases the slot it filled during a suspension, rather than resurrecting it", async () => {
    const { editor, presence, awareness, held } = mountPair();
    insertImageFile(editor, imageFile(), { kind: "inline", pos: 5 });
    await settle();
    const token = pendingImages(editor)[0].id;
    expect(announced(awareness.local)).toEqual([{ token, frame: null }]);

    presence.suspend();
    held[0].settle(asset("landed"));
    await settle();
    expect(awareness.local.getLocalState()).toBeNull();

    presence.resume();

    expect(announced(awareness.local)).toEqual([]);
  });
});
