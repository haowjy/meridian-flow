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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { engageObject } from "@/core/editor/objects";
import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";
import { createReactEditorFixture, type ReactEditorFixture } from "@/test-support/react-editor";
import { requireNode } from "@/test-support/standalone-editor";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

// The one boundary faked here: what is under test is which object a surface is
// aimed at, not mermaid's grammar.
vi.mock("@/core/editor/mermaid-render", () => ({
  renderMermaid: async () => "<svg data-fake-diagram></svg>",
}));

const { ObjectControls } = await import("./ObjectControls");

/** The diagram the writer opens. The other one belongs to the collaborator. */
const WRITER_DIAGRAM = "flowchart LR\nA --> B";
const PEER_DIAGRAM = "flowchart TD\nC --> D";

function fence(text: string) {
  return { type: "code_block", attrs: { language: "mermaid" }, content: [{ type: "text", text }] };
}

let pair: CollabPair;
let page: ReactEditorFixture;

beforeEach(() => {
  pair = createCollabPair({
    type: "doc",
    content: [fence(PEER_DIAGRAM), fence(WRITER_DIAGRAM)],
  });
  page = createReactEditorFixture({ editor: pair.local });
});

afterEach(() => {
  page.destroy();
  pair.destroy();
});

function collab(): CollabPair {
  return pair;
}

/** Where a fence whose source starts with `text` is, in whichever editor. */
function fencePos(instance: CollabPair["local"], text: string): number {
  return requireNode(instance, { type: "code_block", startsWith: text }).pos;
}

/**
 * Open the dialog the way a writer does. `created` is law 2's exception — a
 * brand-new diagram opens on its source — which is also what makes WHICH
 * diagram the dialog is showing readable from the page.
 */
function openLightbox(): void {
  const { local } = collab();
  const target = requireNode(local, { type: "code_block", startsWith: WRITER_DIAGRAM });
  act(() => {
    engageObject(local, target, "created");
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
    page.render(<ObjectControls editor={local} />);
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
    page.render(<ObjectControls editor={local} />);
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
    page.render(<ObjectControls editor={local} />);
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
    const theirs = requireNode(local, { type: "code_block", startsWith: PEER_DIAGRAM });
    act(() => {
      engageObject(local, theirs, "engage");
    });
    expect(lightbox()).not.toBeNull();
    expect(shownSource()).toBeNull();
  });
});
