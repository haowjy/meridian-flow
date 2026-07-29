// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { EditorContent } from "@tiptap/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "./config";

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

  it("shows the fence for a diagram that has never rendered", async () => {
    mountDocument("mermaid", "flowchart LR\nA[");

    // Unrenderable source is the one case the page shows Mermaid syntax: with
    // no diagram standing in for it, hiding the fence would strand the writer.
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Parse error on line 2");
    });
    expect(fenceClass()).not.toContain("hidden");
    expect(document.querySelector("pre")?.textContent).toContain("flowchart LR");
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
