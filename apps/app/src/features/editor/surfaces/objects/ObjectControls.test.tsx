// @vitest-environment jsdom
/**
 * The surfaces this lane opens outlive a keystroke, and every peer write
 * rebuilds the document under them.
 *
 * A real second binding is the only way to test it: y-prosemirror replaces the
 * whole ProseMirror document on every remote change, and the mapping then
 * reports every position deleted whatever the change was. What these surfaces
 * remember is a hold, so an open dialog answers two questions independently —
 * is my diagram still there, and where is it drawn now.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { engageObject } from "@/core/editor/objects";
import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";
import { installJsdomLayout } from "@/test-support/jsdom-layout";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

// The one boundary faked here: what is under test is which object a surface is
// aimed at, not mermaid's grammar.
vi.mock("@/core/editor/mermaid-render", () => ({
  renderMermaid: async () => "<svg data-fake-diagram></svg>",
}));

const { ObjectControls } = await import("./ObjectControls");

installJsdomLayout();

/** The diagram the writer opens. The other one belongs to the collaborator. */
const WRITER_DIAGRAM = "flowchart LR\nA --> B";
const PEER_DIAGRAM = "flowchart TD\nC --> D";

function fence(text: string) {
  return { type: "code_block", attrs: { language: "mermaid" }, content: [{ type: "text", text }] };
}

let pair: CollabPair | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  pair = createCollabPair({
    type: "doc",
    content: [fence(PEER_DIAGRAM), fence(WRITER_DIAGRAM)],
  });
  document.body.append(pair.local.view.dom);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  pair?.destroy();
  pair = null;
  document.body.replaceChildren();
});

function collab(): CollabPair {
  if (!pair) throw new Error("no pair");
  return pair;
}

/** Where a fence whose source starts with `text` is, in whichever editor. */
function fencePos(instance: CollabPair["local"], text: string): number {
  let found: number | null = null;
  instance.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === "code_block" && node.textContent.startsWith(text)) {
      found = pos;
    }
    return found === null;
  });
  if (found === null) throw new Error(`no fence for ${text}`);
  return found;
}

/**
 * Open the dialog the way a writer does. `created` is law 2's exception — a
 * brand-new diagram opens on its source — which is also what makes WHICH
 * diagram the dialog is showing readable from the page.
 */
function openLightbox(): void {
  const { local } = collab();
  const pos = fencePos(local, WRITER_DIAGRAM);
  const node = local.state.doc.nodeAt(pos);
  if (!node) throw new Error("no diagram node");
  act(() => {
    engageObject(local, { pos, node }, "created");
  });
}

/** What the writer sees: the dialog, and the source it is showing. */
function lightbox(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".meridian-object-lightbox");
}

function shownSource(): string | null {
  return (
    document.querySelector<HTMLTextAreaElement>(".meridian-lightbox-source-text")?.value ?? null
  );
}

function peerWrite(write: (peer: CollabPair["peer"]) => void): void {
  const current = collab();
  act(() => {
    write(current.peer);
    current.sync();
  });
}

describe("a surface open on an object, while a peer writes", () => {
  it("keeps the lightbox open and on the same diagram", () => {
    const { local } = collab();
    act(() => root?.render(<ObjectControls editor={local} />));
    openLightbox();
    expect(shownSource()).toBe(WRITER_DIAGRAM);

    peerWrite((peer) => {
      peer.commands.insertContentAt(fencePos(peer, PEER_DIAGRAM) + 1, "PEER ");
    });

    expect(lightbox()).not.toBeNull();
    expect(shownSource()).toBe(WRITER_DIAGRAM);
  });

  it("follows its diagram when a peer's write moves it down the document", () => {
    const { local } = collab();
    act(() => root?.render(<ObjectControls editor={local} />));
    openLightbox();
    const before = fencePos(local, WRITER_DIAGRAM);

    peerWrite((peer) => {
      peer.commands.insertContentAt(0, {
        type: "paragraph",
        content: [{ type: "text", text: "a new opening line" }],
      });
    });

    expect(fencePos(local, WRITER_DIAGRAM)).toBeGreaterThan(before);
    expect(lightbox()).not.toBeNull();
    expect(shownSource()).toBe(WRITER_DIAGRAM);
  });

  it("closes the lightbox, and lets go of it, when the peer deletes the diagram", () => {
    const { local } = collab();
    act(() => root?.render(<ObjectControls editor={local} />));
    openLightbox();
    expect(shownSource()).toBe(WRITER_DIAGRAM);

    peerWrite((peer) => {
      const at = fencePos(peer, WRITER_DIAGRAM);
      peer.commands.deleteRange({
        from: at,
        to: at + (peer.state.doc.nodeAt(at)?.nodeSize ?? 0),
      });
    });

    expect(lightbox()).toBeNull();

    // Nothing is retained for a diagram that is gone: opening the collaborator's
    // diagram shows THEIR source, and the source hatch the deleted dialog had
    // open does not come back with it.
    const theirs = fencePos(local, PEER_DIAGRAM);
    const node = local.state.doc.nodeAt(theirs);
    if (!node) throw new Error("no diagram node");
    act(() => {
      engageObject(local, { pos: theirs, node }, "engage");
    });
    expect(lightbox()).not.toBeNull();
    expect(shownSource()).toBeNull();
  });
});
