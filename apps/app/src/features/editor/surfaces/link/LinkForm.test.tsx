// @vitest-environment jsdom
/** Real anchored form with no catalog/network: display text, destination state, and refusal. */
import { Editor } from "@tiptap/core";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { getLinkSurface } from "@/core/editor/links";
import { installJsdomLayout } from "@/test-support/jsdom-layout";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { LinkForm } from "./LinkForm";

vi.mock("@/features/editor/references/useReferenceBrowserCatalog", () => ({
  useReferenceBrowserCatalog: () => null,
}));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
installJsdomLayout();

describe("link destination form", () => {
  it("shows the selected words and a friendly target; refuses a read-only save visibly", async () => {
    const editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: '<p><a href="[[Gate]]">the gate</a></p>',
    });
    document.body.append(editor.view.dom);
    editor.commands.setTextSelection({ from: 1, to: 9 });
    const surface = getLinkSurface(editor);
    if (!surface) throw new Error("missing link surface");
    surface.openForm({ x: 0, y: 0 });
    const form = surface.state.form;
    if (!form) throw new Error("missing form");
    try {
      await withReactRoot(<LinkForm editor={editor} surface={surface} form={form} />, async () => {
        expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("the gate");
        expect(document.querySelector("form")?.textContent).toContain("Gate");
        expect(document.querySelector("form")?.textContent).not.toContain("[[Gate]]");
        editor.setEditable(false);
        await act(async () =>
          document
            .querySelector("form")
            ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        );
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "can no longer be edited",
        );
        expect(surface.state.form).not.toBeNull();
        expect(editor.state.doc.textContent).toBe("the gate");
      });
    } finally {
      editor.view.dom.remove();
      editor.destroy();
    }
  });
});

it.each([
  "guide.md",
  "Gate|Map.md",
])("saves display text over a scoped destination %s without changing lookup", async (filename) => {
  const editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: `<p><a href="scratch://@revision/${filename}">Guide</a></p>`,
  });
  document.body.append(editor.view.dom);
  editor.commands.setTextSelection({ from: 1, to: 6 });
  const surface = getLinkSurface(editor);
  if (!surface) throw new Error("missing link surface");
  surface.openForm({ x: 0, y: 0 });
  const form = surface.state.form;
  if (!form) throw new Error("missing form");
  try {
    await withReactRoot(<LinkForm editor={editor} surface={surface} form={form} />, async () => {
      const input = document.querySelector<HTMLInputElement>("input");
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          "Walkthrough",
        );
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () =>
        document
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(editor.state.doc.textContent).toBe("Walkthrough");
      expect(
        editor.state.doc.firstChild?.firstChild?.marks.find((mark) => mark.type.name === "link")
          ?.attrs.href,
      ).toBe(`[[scratch://@revision/${filename.replace("|", "\\|")}]]`);
    });
  } finally {
    editor.view.dom.remove();
    editor.destroy();
  }
});
