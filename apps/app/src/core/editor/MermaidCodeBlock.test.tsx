// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "./config";
import {
  isMermaidPreviewRequested,
  renderMermaid,
  setMermaidPreviewRequested,
} from "./MermaidCodeBlock";

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

  it("switches a requested preview to editable code when its surface is pressed", async () => {
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
    const codeBlock = editor.state.doc.firstChild;
    const currentEditor = editor;
    expect(codeBlock).not.toBeNull();
    editor.commands.setTextSelection((codeBlock?.nodeSize ?? 0) + 1);
    setMermaidPreviewRequested(editor, 0, true);

    await vi.waitFor(() => {
      expect(document.querySelector("[data-mermaid-preview]")).not.toBeNull();
    });
    document
      .querySelector("[data-mermaid-preview]")
      ?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(isMermaidPreviewRequested(currentEditor, 0)).toBe(false);
      expect(editor?.state.selection.from).toBe(1);
      expect(document.querySelector("[data-language='mermaid'] pre")?.className).not.toContain(
        "hidden",
      );
    });
  });
});
