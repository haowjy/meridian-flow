// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "./config";
import { renderMermaid } from "./MermaidCodeBlock";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
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

describe("Mermaid code blocks", () => {
  it("does not leave Mermaid's temporary error SVG in the document", async () => {
    const id = "invalid-mermaid-probe";

    await expect(renderMermaid(id, "flowchart LR\nA[")).rejects.toThrow();

    expect(document.getElementById(id)).toBeNull();
    expect(document.body.textContent).not.toContain("Syntax error in text");
  });

  // The Mermaid node view is unregistered until the rebuild's diagram dialog
  // owns source access: rendering the fence hides its `<pre>`, which leaves the
  // caret in a hidden element and drops keystrokes.
  it("leaves a mermaid fence as a plain editable code block", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "code_block",
            attrs: { language: "mermaid" },
            content: [{ type: "text", text: "flowchart LR\nA --> B" }],
          },
          { type: "paragraph", content: [{ type: "text", text: "after" }] },
        ],
      },
    });
    root = createRoot(element);
    root.render(<EditorContent editor={editor} />);

    await vi.waitFor(() => {
      // The schema's own `pre > code.language-mermaid`, not a node-view wrapper.
      expect(document.querySelector("pre > code")?.className).toContain("language-mermaid");
    });
    expect(document.querySelector("[data-node-view-wrapper][data-language]")).toBeNull();
    expect(document.querySelector("[data-mermaid-preview]")).toBeNull();
    expect(document.querySelector("pre > code")?.textContent).toContain("flowchart LR");
  });
});
