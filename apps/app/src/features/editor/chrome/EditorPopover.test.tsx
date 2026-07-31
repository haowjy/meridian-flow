// @vitest-environment jsdom
/**
 * No anchor is not an anchor at the origin.
 *
 * Every typed-under menu is placed against a virtual reference the caller
 * measures, and that measurement really does answer null: a `/` menu's own
 * decoration leaves the DOM the moment the trigger text does, and a peer's
 * write rebuilds the manuscript between two paints. Answering it with a zero
 * `DOMRect` mounted a live surface in the corner of the viewport, over content
 * it had nothing to do with — so the boundary is pinned here rather than in
 * each lane that shares it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createReactEditorFixture, type ReactEditorFixture } from "@/test-support/react-editor";

import { EditorPopover } from "./EditorPopover";

const NOTE = "Table cells hold plain paragraphs.";

let page: ReactEditorFixture;

beforeEach(() => {
  page = createReactEditorFixture({
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "a sentence" }] }],
    },
  });
});

afterEach(() => page.destroy());

function show(anchorRect: () => DOMRect | null): Promise<void> {
  return page.render(
    <EditorPopover
      editor={page.editor}
      id="slash-menu"
      open
      onOpenChange={() => {}}
      anchorRect={anchorRect}
      focusOnOpen="prose"
    >
      <div>{NOTE}</div>
    </EditorPopover>,
  );
}

describe("an editor popover with nowhere to go", () => {
  it("mounts nothing while its anchor cannot be measured", async () => {
    await show(() => null);

    expect(document.body.textContent).not.toContain(NOTE);
  });

  it("stays where it last was when one frame cannot measure it", async () => {
    let rect: DOMRect | null = new DOMRect(120, 240, 0, 0);
    await show(() => rect);
    expect(document.body.textContent).toContain(NOTE);

    // The trigger's decoration is out of the DOM for a beat while a peer's
    // write is applied. Closing on that would take the menu away every time a
    // collaborator typed anywhere in the chapter.
    rect = null;
    await show(() => rect);

    expect(document.body.textContent).toContain(NOTE);
  });
});
