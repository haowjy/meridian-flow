// @vitest-environment jsdom
/**
 * The link mark's view carries its resolution state on the focusable `<a>`,
 * including for links in the content an editor is constructed with.
 */
import { Editor } from "@tiptap/core";
import { expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { LINK_SURFACE_NAME } from "./link-storage";

const GONE_REF = "doc:00000000-0000-4000-8000-0000000000aa";
const KAEL = "manuscript://Kael.md";

it("marks a gone link present at mount on its <a>, and hands its presses to the editor", async () => {
  const onUpdate = vi.fn();
  const editor = new Editor({
    // Attached, so the chip can take focus for Enter.
    element: document.body.appendChild(document.createElement("div")),
    extensions: createStandaloneEditorExtensions({}),
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "See " },
            {
              type: "text",
              text: "Kael",
              marks: [{ type: "link", attrs: { href: KAEL, ref: GONE_REF } }],
            },
            { type: "text", text: "." },
          ],
        },
      ],
    },
    onUpdate,
  });
  try {
    editor.storage[LINK_SURFACE_NAME].resolution.registerResolver({
      remote: async (questions) => questions.map(() => ({ state: "gone", document: null })),
    });
    editor.storage[LINK_SURFACE_NAME].resolution.request([{ ref: GONE_REF, href: KAEL }]);

    const anchor = editor.view.dom.querySelector("a");
    await vi.waitFor(() => expect(anchor?.getAttribute("aria-disabled")).toBe("true"));
    expect(anchor?.getAttribute("aria-description")).toBe("No longer available");
    // The view's MutationObserver delivers asynchronously; let it run.
    await new Promise((settled) => setTimeout(settled, 0));
    expect(onUpdate).not.toHaveBeenCalled();

    // Known gone, a press is the editor's: the click falls through to place
    // the caret, and Enter and Alt+Enter mean what they mean in text.
    const navigate = vi.fn();
    editor.storage[LINK_SURFACE_NAME].surface.registerNavigator(navigate);
    const click = editor.view.state.plugins.find((plugin) =>
      (plugin as unknown as { key: string }).key.startsWith(LINK_SURFACE_NAME),
    )?.props.handleDOMEvents?.click;
    const press = new MouseEvent("click", { button: 0, bubbles: true });
    anchor?.dispatchEvent(press);
    expect
      .soft(click?.call(null as never, editor.view, press as PointerEvent), "click")
      .toBe(false);
    expect.soft(navigate, "click follows nothing").not.toHaveBeenCalled();
    editor.commands.setTextSelection(6);
    anchor?.focus();
    const enter = (altKey: boolean) =>
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", altKey, bubbles: true }),
      );
    navigate.mockClear();
    enter(true);
    expect.soft(navigate, "Alt+Enter follows nothing").not.toHaveBeenCalled();
    navigate.mockClear();
    enter(false);
    expect.soft(navigate, "Enter follows nothing").not.toHaveBeenCalled();
    expect.soft(editor.state.doc.childCount, "Enter splits the paragraph").toBe(2);
  } finally {
    editor.destroy();
  }
});
