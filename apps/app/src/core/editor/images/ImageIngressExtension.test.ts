// @vitest-environment jsdom
/**
 * The pending picture is a document fact.
 *
 * Every case here is a claim about the DOCUMENT while bytes are in flight — the
 * claim the old shell-level upload status could not make. The upload port is
 * held open deliberately: what the writer can see and do mid-upload is the
 * whole subject, so nothing may depend on it having finished.
 *
 * Most of that is one writer alone, so `mount` is one editor. `mountPair`
 * brings a real collaborator, and a case reaches for it only when its own claim
 * names one: y-prosemirror rebuilds the whole document and reports every
 * position deleted, which is the hazard the anchored hold exists for, and undo
 * on a shared document is the Yjs UndoManager rather than ProseMirror's own
 * history.
 */
import type { Editor, JSONContent } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";
import { createStandaloneEditor, requireNode } from "@/test-support/standalone-editor";

// A refused door says why (law 5), and the reason is a macro the test transform
// does not compile. The lane's copy is not what these cases are about.
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + String(values[index - 1] ?? "") + part),
}));

// jsdom ships no `ClipboardEvent`, and ProseMirror's own `pasteHTML` builds one
// when it is not handed an event. The browser has it; the harness does not.
if (typeof globalThis.ClipboardEvent === "undefined") {
  class StubClipboardEvent extends Event {}
  Object.defineProperty(globalThis, "ClipboardEvent", { value: StubClipboardEvent });
}

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
  removePendingImage,
  retryPendingImage,
} from "./image-uploads";
import type { PendingImage } from "./pending-images";

/**
 * Every picture this editor is waiting on.
 *
 * The record itself is the subject of this suite, so it is read directly — and
 * from here rather than from a production export, because no surface asks the
 * question this way: the app renders ingress from the document's decorations
 * and from `imageIngressStatus`.
 */
function pendingImages(editor: Editor | null): readonly PendingImage[] {
  return Array.from(ingressState(editor).pending.values());
}

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

/** One writer, with both of the lane's ports held open. */
function mount(document: string | JSONContent = "The gate opened."): Ingress {
  const standalone = createStandaloneEditor({
    content: typeof document === "string" ? documentSaying(document) : document,
  });
  close = standalone.destroy;
  return withHeldPorts(standalone.editor);
}

/** The same document, with a collaborator bound to it. */
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

/** Both doors bytes travel through, answered by the test rather than a server. */
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

/**
 * What this editor draws over the picture at `pos`, read off the manuscript
 * itself rather than off plugin state: `data-pending-image` is the decoration
 * attribute `ImageNodeView` branches on, so this is the peer's rendering.
 */
function slotStatus(editor: Editor, pos: number): string | null {
  const dom = editor.view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom.getAttribute("data-pending-image") : null;
}

/** What this client is announcing on the ephemeral channel: tokens and shapes. */
function announced(awareness: { getLocalState: () => Record<string, unknown> | null }) {
  return (awareness.getLocalState()?.imageUploads ?? []) as readonly {
    token: string;
    frame: { width: number; height: number } | null;
  }[];
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

  it("keeps the slot's upload token out of every HTML the editor writes", async () => {
    const { editor } = mount();
    insertImageFile(editor, imageFile(), 5);
    await settle();

    // The token is a live-session fact. On the clipboard it would put a second
    // node under one upload; in a saved file it would name an owner that is gone.
    expect(editor.getHTML().toLowerCase()).not.toContain("uploadtoken");
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
    const { editor, peer, sync, held } = mountPair();
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

describe("a peer sees an upload it does not own as an upload", () => {
  it("shows the slot as uploading elsewhere while its owner is live", async () => {
    const { editor, peer, sync, syncAwareness } = mountPair();
    insertImageFile(editor, imageFile(), 5);
    await settle();
    sync();
    syncAwareness();
    await settle();

    // Same node, two clients, two honest readings: mine is uploading, theirs is
    // uploading somewhere else. Neither is "this never finished".
    expect(imageNodes(peer)).toEqual([{ pos: 5, src: "", alt: "cover art" }]);
    expect(slotStatus(editor, 5)).toBe("uploading");
    expect(slotStatus(peer, 5)).toBe("elsewhere");
  });

  it("stops claiming an owner once the upload lands", async () => {
    const { editor, peer, sync, syncAwareness, awareness, held } = mountPair();
    insertImageFile(editor, imageFile(), 5);
    await settle();
    sync();
    syncAwareness();

    held[0].settle(asset("asset-peer"));
    await settle();
    sync();
    syncAwareness();
    await settle();

    expect(imageNodes(peer)).toEqual([{ pos: 5, src: "asset:asset-peer", alt: "Cover art" }]);
    expect(slotStatus(peer, 5)).toBe(null);
    expect(announced(awareness.local)).toEqual([]);
  });

  it("leaves an ownerless empty slot recoverable, not in flight", async () => {
    const { editor, peer, sync } = mountPair();
    // No owner ever announced this one: a reload's leftover, or a redo that
    // brought back an insert whose bytes are gone.
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
    insertImageFile(editor, imageFile(), 5);
    await settle();

    // One transaction, delete plus insert: the move y-prosemirror reconciles as
    // a new identity, and the shape a drag inside the manuscript produces.
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
    insertImageFile(editor, imageFile(), 5);
    await settle();
    // The token this client owns, and nothing a peer could not act on: no
    // filename, no percent, no bytes.
    expect(announced(awareness.local)).toEqual([
      { token: pendingImages(editor)[0].id, frame: null },
    ]);

    editor.destroy();

    expect(held[0].signal.aborted).toBe(true);
    expect(announced(awareness.local)).toEqual([]);
  });

  it("aborts a pending import on destroy", async () => {
    const { editor, bytes } = mount();
    editor.view.pasteHTML('<p><img src="https://example.test/one.png" alt="One"></p>');
    await settle();
    expect(bytes.calls).toEqual(["https://example.test/one.png"]);
    expect(pendingImages(editor)).toHaveLength(1);

    editor.destroy();

    expect(bytes.aborted).toEqual(["https://example.test/one.png"]);
  });
});

/**
 * The chooser, held open the way the operating system holds it.
 *
 * `pickImageFile` creates an `<input type=file>` and clicks it, so the click is
 * where the writer leaves the editor: the test records the input, lets the
 * document move underneath, and hands a file back whenever it likes.
 */
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

/** A block a peer writes in above, carrying a picture of its own. */
function peerPictureBlock(editor: Editor) {
  return editor.state.schema.nodes.paragraph.create(null, [
    editor.state.schema.text("abcd"),
    editor.state.schema.nodes.image.create({ src: "asset:peer", alt: "peer" }),
  ]);
}

/** A stat block, so the place a writer asks from is one cell of a table. */
function documentWithTable(): JSONContent {
  const cell = (text: string): JSONContent => ({
    type: "table_cell",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "The gate opened." }] },
      { type: "table", content: [{ type: "table_row", content: [cell("rank"), cell("skill")] }] },
    ],
  };
}

/** The paragraph this picture landed in, and the table role of whatever holds it. */
function pictureHome(editor: Editor, alt: string): { text: string; role: unknown } {
  const at = imageNodes(editor).find((node) => node.alt === alt)?.pos;
  if (at === undefined) throw new Error(`no picture called ${alt} in the document`);
  const $at = editor.state.doc.resolve(at);
  return { text: $at.parent.textContent, role: $at.node(-1).type.spec.tableRole };
}

/**
 * A new picture goes where it was asked for, and the ask outlives the chooser.
 *
 * This is the seam a slash pick from a table cell rides: the writer types `/`
 * in a cell, picks Image, and is then in front of an operating-system dialog
 * while their own caret and everybody else's writes move the document. A picker
 * that read the selection when the file came back put the picture wherever the
 * writer happened to be standing — which for a cell meant past the whole table.
 */
describe("a new picture lands where the writer asked for it", () => {
  it("lands in the cell it was asked from, after the caret moves and a peer writes", async () => {
    const { editor, peer, sync, held } = mountPair(documentWithTable());
    const rank = requireNode(editor, { type: "paragraph", startsWith: "rank" });
    const askedAt = rank.pos + 1 + rank.node.content.size;
    editor.commands.setTextSelection(askedAt);

    const chooseFile = openChooser(() => openImagePicker(editor, imageCaretTarget(editor)));

    // The writer clicks back into the prose above while the dialog is up, and a
    // collaborator writes a whole block in over the top of the document, so
    // every raw number the pick was made against now means something else.
    editor.commands.setTextSelection(2);
    peer.view.dispatch(peer.state.tr.insert(0, peerPictureBlock(peer)));
    sync();
    await settle();

    chooseFile(imageFile("portrait.png"));
    await settle();

    expect(held).toHaveLength(1);
    expect(pictureHome(editor, "portrait")).toEqual({ text: "rank", role: "cell" });
    // And the caret is after the picture, in the same cell: the writer is where
    // the picture is, not where they clicked while they waited.
    expect(editor.state.selection.$from.node(-1).type.spec.tableRole).toBe("cell");
  });

  it("refuses out loud when the place is gone by the time the file comes back", async () => {
    const { editor, peer, sync, held } = mountPair(documentWithTable());
    const rank = requireNode(editor, { type: "paragraph", startsWith: "rank" });
    editor.commands.setTextSelection(rank.pos + 1);
    const table = requireNode(editor, "table");

    const chooseFile = openChooser(() => openImagePicker(editor, imageCaretTarget(editor)));

    // The collaborator takes the whole table away. There is no cell to land in,
    // and landing anywhere else would be a picture the writer never asked for.
    peer.view.dispatch(peer.state.tr.delete(table.pos, table.pos + table.node.nodeSize));
    sync();
    await settle();

    chooseFile(imageFile("portrait.png"));
    await settle();

    expect(held).toEqual([]);
    expect(imageNodes(editor)).toEqual([]);
    expect(pendingImages(editor)).toEqual([]);
    expect(imageIngressStatus(editor)?.getSnapshot().notice?.message).toBe(
      "There is nowhere left to put that picture.",
    );
  });
});

/** A 2x2 stat table alone in the document, so a whole-table sweep is cheap. */
function tableDocument2x2(): JSONContent {
  const cell = (text: string): JSONContent => ({
    type: "table_cell",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  return {
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          { type: "table_row", content: [cell("a1"), cell("a2")] },
          { type: "table_row", content: [cell("b1"), cell("b2")] },
        ],
      },
    ],
  };
}

/** Sweep a `CellSelection` between two cells, by row-major index. */
function sweepCells(editor: Editor, anchorIndex: number, headIndex: number): void {
  const cells: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === "cell") cells.push(pos);
    return true;
  });
  const selection = CellSelection.create(editor.state.doc, cells[anchorIndex], cells[headIndex]);
  editor.view.dispatch(editor.state.tr.setSelection(selection));
}

/** Each cell's child block types and flattened text, in document order. */
function cellStates(editor: Editor): { blocks: string[]; text: string }[] {
  const cells: { blocks: string[]; text: string }[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.spec.tableRole === "cell") {
      const blocks: string[] = [];
      node.forEach((child) => {
        blocks.push(child.type.name);
      });
      cells.push({ blocks, text: node.textContent });
    }
    return true;
  });
  return cells;
}

/** A real paste of an image file, through the view's own paste pipeline. */
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

/**
 * A pasted file is still a paste: over a swept rectangle of cells it means what
 * every paste over a sweep means (`../table-sweep-paste.ts`) — the sweep is
 * replaced, the picture lands in the top-left cell — and at a caret it is the
 * picture landing inline, exactly as before.
 */
describe("an image file pasted over a sweep replaces the sweep", () => {
  it("empties the swept cells and lands the picture's paragraph in the top-left cell", async () => {
    const { editor, held } = mount(tableDocument2x2());
    sweepCells(editor, 0, 3);

    pasteFile(editor, imageFile());
    await settle();

    expect(held).toHaveLength(1);
    expect(cellStates(editor)).toEqual([
      { blocks: ["paragraph"], text: "" },
      { blocks: ["paragraph"], text: "" },
      { blocks: ["paragraph"], text: "" },
      { blocks: ["paragraph"], text: "" },
    ]);
    // The picture stands in the top-left cell's own paragraph, in flight.
    expect(imageNodes(editor)).toHaveLength(1);
    expect(pictureHome(editor, "cover art")).toEqual({ text: "", role: "cell" });
    // The caret follows it into the cell, ready to keep writing beside it.
    expect(editor.state.selection.$from.node(-1).type.spec.tableRole).toBe("cell");
  });

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

  it("still lands a caret paste inline where the caret is", async () => {
    const { editor, held } = mount();
    editor.commands.setTextSelection(5);

    pasteFile(editor, imageFile());
    await settle();

    expect(held).toHaveLength(1);
    expect(imageNodes(editor)).toEqual([{ pos: 5, src: "", alt: "cover art" }]);
  });
});

describe("Replace aims at the picture the writer pointed at", () => {
  it("lands on the original picture after a peer writes a picture in above", async () => {
    const { editor, peer, sync, held } = mountPair();
    insertImageFile(editor, imageFile(), 5);
    await settle();
    held[0].settle(asset("old"));
    await settle();
    sync();

    const chooseFile = openChooser(() =>
      openImagePicker(editor, imageReplaceTarget(editor, imageNodes(editor)[0].pos)),
    );

    // The peer's block arrives while the chooser is still open, and its own
    // picture now starts at the number the original one had.
    peer.view.dispatch(peer.state.tr.insert(0, peerPictureBlock(peer)));
    sync();
    await settle();

    chooseFile(imageFile("replacement.png"));
    await settle();
    expect(held).toHaveLength(2);
    held[1].settle(asset("new"));
    await settle();

    expect(imageNodes(editor).map((node) => node.src)).toEqual(["asset:peer", "asset:new"]);
  });

  it("opens nothing when the picture is gone by the time the file comes back", async () => {
    const { editor, held } = mount();
    insertImageFile(editor, imageFile(), 5);
    await settle();
    held[0].settle(asset("old"));
    await settle();

    const at = imageNodes(editor)[0].pos;
    const chooseFile = openChooser(() => openImagePicker(editor, imageReplaceTarget(editor, at)));
    editor.view.dispatch(editor.state.tr.delete(at, at + 1));
    await settle();

    chooseFile(imageFile("replacement.png"));
    await settle();

    // No second request, so no asset the project has no use for, and nothing in
    // flight for a slot that does not exist.
    expect(held).toHaveLength(1);
    expect(pendingImages(editor)).toEqual([]);
    expect(imageNodes(editor)).toEqual([]);
  });

  it("takes the whole replacement back in one undo", async () => {
    // Undo on a shared document is the Yjs UndoManager, so the shared document
    // is what these two cases are for — not a peer.
    const { editor, held } = mountPair();
    insertImageFile(editor, imageFile(), 5);
    await settle();
    held[0].settle(asset("old"));
    await settle();
    // An earlier edit of the writer's, which one undo must not reach past.
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

    expect(editor.commands.undo()).toBe(true);
    await settle();

    expect(imageNodes(editor).map((node) => node.src)).toEqual(["asset:old"]);
    expect(editor.state.doc.textContent).toBe("Then The gate opened.");
  });

  it("still undoes an inserted picture away, bytes and all", async () => {
    const { editor, held } = mountPair();
    insertImageFile(editor, imageFile(), 5);
    await settle();
    held[0].settle(asset("only"));
    await settle();

    expect(editor.commands.undo()).toBe(true);
    await settle();

    expect(imageNodes(editor)).toEqual([]);
    expect(editor.state.doc.textContent).toBe("The gate opened.");
  });
});

describe("an announcement made while the writer is hidden is still true after", () => {
  it("releases the slot it filled during a suspension, rather than resurrecting it", async () => {
    const { editor, presence, awareness, held } = mountPair();
    insertImageFile(editor, imageFile(), 5);
    await settle();
    const token = pendingImages(editor)[0].id;
    expect(announced(awareness.local)).toEqual([{ token, frame: null }]);

    // Inline review opens over the document, and the bytes land behind it.
    presence.suspend();
    held[0].settle(asset("landed"));
    await settle();
    expect(awareness.local.getLocalState()).toBeNull();

    presence.resume();

    expect(announced(awareness.local)).toEqual([]);
  });
});

/**
 * Everything about the document except which picture a node points at and
 * whether an upload is still filling it. Landing writes exactly those, on the
 * node that was already there; anything else differing means the manuscript
 * moved.
 */
function withoutImageSrc(doc: unknown): unknown {
  if (Array.isArray(doc)) return doc.map(withoutImageSrc);
  if (doc && typeof doc === "object") {
    const entries = Object.entries(doc as Record<string, unknown>).map(([key, value]) =>
      key === "attrs" && (doc as { type?: string }).type === "image"
        ? [
            key,
            {
              ...(value as Record<string, unknown>),
              src: "<src>",
              alt: "<alt>",
              uploadToken: "<token>",
            },
          ]
        : [key, withoutImageSrc(value)],
    );
    return Object.fromEntries(entries);
  }
  return doc;
}
