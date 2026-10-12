// @vitest-environment jsdom
/**
 * The link mark's view is the only thing that draws a link's answer: it asks
 * through the editor's requester and carries the chip and the accessible
 * state on the focusable `<a>`, including for links in the content an editor
 * is constructed with.
 */
import { Editor } from "@tiptap/core";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import type { LinkQuestion } from "./link-resolution";
import { LINK_SURFACE_NAME } from "./link-storage";

const GONE_REF = "doc:00000000-0000-4000-8000-0000000000aa";
const KAEL = "manuscript://Kael.md";

it("marks a gone link present at mount on its <a>, and hands its presses to the editor", async () => {
  const onUpdate = vi.fn();
  const gone = { type: "link", attrs: { href: KAEL, ref: GONE_REF } };
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
            // Mixed formatting inside one label is still one link and one chip.
            { type: "text", text: "Ka", marks: [gone] },
            { type: "text", text: "el", marks: [gone, { type: "strong" }] },
            { type: "text", text: ". " },
            // An empty ref is no ref, on every surface that reads the mark.
            {
              type: "text",
              text: "Nine",
              marks: [{ type: "link", attrs: { href: "manuscript://Nine.md", ref: "" } }],
            },
          ],
        },
      ],
    },
    onUpdate,
  });
  try {
    const { resolution } = editor.storage[LINK_SURFACE_NAME];
    const asked: LinkQuestion[][] = [];
    // Nothing requests a key here: the mark views ask, as one batch.
    resolution.registerResolver({
      remote: async (questions) => {
        asked.push([...questions]);
        return questions.map(({ ref }) => ({
          state: ref === null ? "missing" : "gone",
          document: null,
        }));
      },
    });

    const anchors = () => editor.view.dom.querySelectorAll("a");
    await vi.waitFor(() => expect(anchors()[0]?.getAttribute("aria-disabled")).toBe("true"));
    const anchor = anchors()[0];
    expect.soft(anchors(), "one <a> per label").toHaveLength(2);
    expect
      .soft(
        asked.map((batch) => batch.map(({ ref }) => ref)),
        "one batch",
      )
      .toEqual([[GONE_REF, null]]);
    expect.soft(anchor?.getAttribute("aria-description")).toBe("No longer available");
    expect.soft(anchor?.getAttribute("data-link-chip"), "gone draws dashed").toBe("dashed");
    expect.soft(anchor?.getAttribute("data-link-chip-icon")).toBe("manuscript");
    const noRef = anchors()[1];
    await vi.waitFor(() => expect(noRef?.hasAttribute("aria-description")).toBe(true));
    expect.soft(noRef?.getAttribute("aria-description"), "empty ref").toBe("Doesn't exist yet");
    expect.soft(noRef?.getAttribute("data-link-chip"), "missing draws dashed").toBe("dashed");
    // The view's MutationObserver delivers asynchronously; let it run.
    await new Promise((settled) => setTimeout(settled, 0));
    expect(onUpdate).not.toHaveBeenCalled();

    // A peer's write replaces the whole document in one step, and the chip
    // survives it without asking again.
    editor.view.dispatch(
      editor.state.tr
        .replaceWith(0, editor.state.doc.content.size, editor.state.doc.content)
        .setMeta(ySyncPluginKey, { isChangeOrigin: true }),
    );
    expect
      .soft(anchors()[0]?.getAttribute("data-link-chip"), "after a remote rebuild")
      .toBe("dashed");
    expect.soft(anchors()[0]?.getAttribute("aria-disabled")).toBe("true");

    // Known gone, a press is the editor's: the click falls through to place
    // the caret, and Enter and Alt+Enter mean what they mean in text.
    const navigate = vi.fn();
    editor.storage[LINK_SURFACE_NAME].surface.registerNavigator(navigate);
    const click = editor.view.state.plugins.find((plugin) =>
      (plugin as unknown as { key: string }).key.startsWith(LINK_SURFACE_NAME),
    )?.props.handleDOMEvents?.click;
    const press = new MouseEvent("click", { button: 0, bubbles: true });
    anchors()[0]?.dispatchEvent(press);
    expect
      .soft(click?.call(null as never, editor.view, press as PointerEvent), "click")
      .toBe(false);
    expect.soft(navigate, "click follows nothing").not.toHaveBeenCalled();
    editor.commands.setTextSelection(6);
    anchors()[0]?.focus();
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

    // A destroyed mark view releases its link: the next generation asks only
    // about the link still on the page.
    editor.view.dispatch(
      editor.state.tr.removeMark(
        0,
        editor.state.doc.content.size,
        editor.schema.marks.link.create(gone.attrs),
      ),
    );
    asked.length = 0;
    resolution.registerResolver({
      remote: async (questions) => {
        asked.push([...questions]);
        return questions.map(() => ({ state: "missing", document: null }));
      },
    });
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect
      .soft(
        asked[0]?.map(({ ref }) => ref),
        "only the live link is asked",
      )
      .toEqual([null]);
  } finally {
    editor.destroy();
  }
});
