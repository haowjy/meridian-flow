// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { EditorContent } from "@tiptap/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "./config";
import { registerObjectEngagement } from "./objects";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

// The parser is the one boundary these tests fake: what is under test is what
// the node view does with a render that succeeded or failed, not mermaid's
// grammar. `RENDERS` is the source both faces agree parses.
const RENDERS = "flowchart LR\nA --> B";
vi.mock("./mermaid-render", () => ({
  renderMermaid: async (_id: string, source: string) => {
    if (source !== RENDERS) throw new Error("Parse error on line 2");
    return "<svg data-fake-diagram></svg>";
  },
}));

let editor: Editor | null = null;
let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

function mountDocument(language: string, source: string): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const mounted = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "code_block",
          attrs: { language },
          content: [{ type: "text", text: source }],
        },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    },
  });
  editor = mounted;
  root = createRoot(element);
  root.render(<EditorContent editor={mounted} />);
  return mounted;
}

const fenceClass = () => document.querySelector("pre")?.className ?? "";
const errorCard = () => document.querySelector(".meridian-diagram-error");

/** The face the writer presses: the picture, the error card, or the placeholder. */
function diagramBody(): Element {
  const body = document.querySelector('.meridian-diagram-block [contenteditable="false"]');
  if (!body) throw new Error("expected a diagram body");
  return body;
}

/** A real press, and whether anything refused its default. */
function mouseDown(element: Element): boolean {
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Long enough for React to flush an update it should never have made. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

/**
 * Focus, with the caret in the paragraph after the fence.
 *
 * Focusing a document whose FIRST block is the fence lands the caret inside
 * it, which is a different story than the one a pointer test is telling.
 */
async function landCaretInProse(mounted: Editor): Promise<void> {
  mounted.view.focus();
  mounted.view.dispatch(
    mounted.state.tr.setSelection(
      TextSelection.create(mounted.state.doc, mounted.state.doc.content.size - 1),
    ),
  );
  await vi.waitFor(() => {
    expect(fenceClass()).toContain("hidden");
  });
}

/** The element ProseMirror writes this fence's text into. */
function contentHost(): Element {
  const host = document.querySelector("[data-node-view-content]");
  if (!host) throw new Error("expected a node view content host");
  return host;
}

/**
 * Everything the browser walks past to reach the content host.
 *
 * The node view's structural invariant, said as a list: a face change may
 * never add, remove, or reorder DOM ahead of the host, because that is DOM
 * moving in front of ProseMirror's live selection.
 */
function domAheadOfHost(): Element[] {
  const wrapper = document.querySelector(".meridian-diagram-block");
  if (!wrapper) throw new Error("expected a diagram block");
  const host = contentHost();
  const ahead: Element[] = [];
  for (const child of Array.from(wrapper.children)) {
    ahead.push(child);
    if (child.contains(host)) return ahead;
  }
  throw new Error("content host is not inside the node view wrapper");
}

/** Every face the fence wears from now on, in order. */
function recordFaces(): { faces: string[]; stop: () => void } {
  const pre = document.querySelector("pre");
  if (!pre) throw new Error("expected a fence");
  const faces: string[] = [];
  const observer = new MutationObserver(() => {
    const face = pre.className.includes("hidden") ? "render" : "source";
    if (faces.at(-1) !== face) faces.push(face);
  });
  observer.observe(pre, { attributes: true, attributeFilter: ["class"] });
  return { faces, stop: () => observer.disconnect() };
}

/** Longer than one render debounce, so a face that waits on the parser shows. */
function settleThroughRenderDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

/** Is the model selection strictly inside the fence at the top of the fixture? */
function selectionInsideFence(mounted: Editor): boolean {
  const fence = mounted.state.doc.firstChild;
  if (!fence) return false;
  const { from, to } = mounted.state.selection;
  return from > 0 && to < fence.nodeSize;
}

describe("Mermaid code blocks", () => {
  it("renders a mermaid fence as a diagram and hides its source", async () => {
    mountDocument("mermaid", RENDERS);

    await vi.waitFor(() => {
      expect(document.querySelector("[data-mermaid-preview] svg")).not.toBeNull();
    });
    expect(fenceClass()).toContain("hidden");
  });

  it("keeps a non-mermaid fence a plain code block", async () => {
    mountDocument("typescript", "const answer = 42;");

    await vi.waitFor(() => {
      expect(document.querySelector("pre > code")?.textContent).toContain("const answer");
    });
    expect(document.querySelector("[data-mermaid-preview]")).toBeNull();
    expect(fenceClass()).not.toContain("hidden");
  });

  it("shows an error card, never the fence, for source that has never rendered", async () => {
    mountDocument("mermaid", "flowchart LR\nA[");

    // §5.2: the page never shows Mermaid syntax, not even when the syntax is
    // what broke. The card holds the diagram's place and names the problem.
    await vi.waitFor(() => {
      expect(errorCard()).not.toBeNull();
    });
    expect(errorCard()?.textContent).toContain("Parse error on line 2");
    expect(fenceClass()).toContain("hidden");
  });

  it("engages the source pane from the error card", async () => {
    const mounted = mountDocument("mermaid", "flowchart LR\nA[");
    const openings: string[] = [];
    registerObjectEngagement(mounted, "code_block", (_target, opening) => {
      openings.push(opening);
    });

    await vi.waitFor(() => {
      expect(document.querySelector(".meridian-diagram-error button")).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>(".meridian-diagram-error button")?.click();

    await vi.waitFor(() => {
      expect(openings).toEqual(["engage"]);
    });
    // Selected underneath, so closing the dialog lands on the diagram.
    expect(mounted.state.selection).toBeInstanceOf(NodeSelection);
  });

  it("selects the diagram on the press, and never shows source", async () => {
    // The whole bug, in one gesture. Before the fix the browser answered the
    // press first: pressing the picture sent it hunting for the nearest
    // editable position, it found the fence's hidden text, and the node view
    // brought the source back to keep those keystrokes reachable. Selecting on
    // the press and refusing the default is what leaves nothing to answer.
    const mounted = mountDocument("mermaid", RENDERS);
    await landCaretInProse(mounted);

    const body = diagramBody();
    expect(mouseDown(body)).toBe(true);
    expect(mounted.state.selection).toBeInstanceOf(NodeSelection);
    expect(fenceClass()).toContain("hidden");

    await settle();
    expect(fenceClass()).toContain("hidden");
    expect(document.querySelector("[data-mermaid-preview] svg")).not.toBeNull();
  });

  it("holds the diagram through a press that never becomes a click", async () => {
    // Two ways a press stops short of `handleClickOn`: it travels past the
    // click slop, or it never releases over the editor at all. Both left the
    // source showing for as long as the selection stayed inside.
    const mounted = mountDocument("mermaid", RENDERS);
    await landCaretInProse(mounted);

    const body = diagramBody();
    mouseDown(body);
    body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 400 }));

    await settle();
    expect(fenceClass()).toContain("hidden");
    expect(mounted.state.selection).toBeInstanceOf(NodeSelection);

    // Released far away, or not released at all: the selection stands either way.
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await settle();
    expect(fenceClass()).toContain("hidden");
  });

  it("brings the source back whenever a caret is inside it", async () => {
    // The hazard this guards: a rendered diagram hides its own `<pre>`, and a
    // caret in a `display: none` element eats every keystroke it is given.
    const mounted = mountDocument("mermaid", RENDERS);

    await vi.waitFor(() => {
      expect(fenceClass()).toContain("hidden");
    });

    mounted.view.focus();
    mounted.view.dispatch(
      mounted.state.tr.setSelection(TextSelection.create(mounted.state.doc, 3)),
    );

    await vi.waitFor(() => {
      expect(fenceClass()).not.toContain("hidden");
    });
  });
});

describe("a diagram that stops parsing", () => {
  it("keeps the last good render and says what broke", async () => {
    const mounted = mountDocument("mermaid", RENDERS);

    await vi.waitFor(() => {
      expect(document.querySelector("[data-mermaid-preview] svg")).not.toBeNull();
    });

    // The writer (or a peer) leaves the source unparseable. What was on the
    // page is still the truest picture of the diagram there is.
    let pos = -1;
    mounted.state.doc.descendants((node, at) => {
      if (node.type.name === "code_block") pos = at;
      return true;
    });
    const node = mounted.state.doc.nodeAt(pos);
    if (!node) throw new Error("expected a fence");
    mounted.view.dispatch(mounted.state.tr.insertText(" and then", pos + node.nodeSize - 1));

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Parse error on line 2");
    });
    // Both, not either: the render stays AND the failure is visible.
    expect(document.querySelector("[data-mermaid-preview] svg")).not.toBeNull();
    expect(fenceClass()).toContain("hidden");
  });
});

describe("a caret inside a rendered diagram", () => {
  it("converges on the source face and leaves the selection where it found it", async () => {
    // The invariant, both halves. A caret inside the fence must bring back a
    // visible, connected source host — and rendering that must not move the
    // selection, or the two faces alternate forever. The caret arrives by
    // transaction because provenance is exactly what this must not depend on:
    // a command, a peer's mapped write, and a press answered at a boundary all
    // land here.
    const mounted = mountDocument("mermaid", RENDERS);
    await vi.waitFor(() => {
      expect(document.querySelector("[data-mermaid-preview] svg")).not.toBeNull();
    });
    await landCaretInProse(mounted);
    expect(mounted.isFocused).toBe(true);

    const host = contentHost();
    const aheadWhileRendered = domAheadOfHost();
    const recorded = recordFaces();

    mounted.view.dispatch(
      mounted.state.tr.setSelection(TextSelection.create(mounted.state.doc, 3)),
    );

    await vi.waitFor(() => {
      expect(fenceClass()).not.toContain("hidden");
    });
    await settleThroughRenderDebounce();

    expect(selectionInsideFence(mounted)).toBe(true);
    expect(fenceClass()).not.toContain("hidden");
    expect(recorded.faces).toEqual(["source"]);
    expect(contentHost()).toBe(host);
    expect(host.isConnected).toBe(true);
    expect(domAheadOfHost()).toEqual(aheadWhileRendered);

    // Out again, once: the render comes back and the swap is still one-way.
    mounted.view.dispatch(
      mounted.state.tr.setSelection(
        TextSelection.create(mounted.state.doc, mounted.state.doc.content.size - 1),
      ),
    );

    await vi.waitFor(() => {
      expect(fenceClass()).toContain("hidden");
    });
    await settleThroughRenderDebounce();
    recorded.stop();

    expect(recorded.faces).toEqual(["source", "render"]);
    expect(selectionInsideFence(mounted)).toBe(false);
    expect(contentHost()).toBe(host);
    expect(host.isConnected).toBe(true);
    expect(domAheadOfHost()).toEqual(aheadWhileRendered);
  });
});
