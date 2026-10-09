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

it("marks a gone link present at mount on its <a>, without a document change", async () => {
  const onUpdate = vi.fn();
  const editor = new Editor({
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
  } finally {
    editor.destroy();
  }
});
