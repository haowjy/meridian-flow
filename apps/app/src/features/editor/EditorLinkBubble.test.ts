// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { type BubbleContext, selectBubbleContext } from "./EditorBubbleHost";
import { linkBubbleContext, matchExistingLink, matchLinkEntry } from "./EditorLinkBubble";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("link bubble arbitration", () => {
  it("claims plain text only through explicit entry", () => {
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: "<p>plain text</p>",
    });
    editor.commands.setTextSelection({ from: 1, to: 6 });

    expect(matchExistingLink(editor)).toBeNull();
    expect(matchLinkEntry(editor)).toMatchObject({ from: 1, to: 6 });
  });

  it("yields a selected image to the next registered context", () => {
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: '<p>before<img src="image.png">after</p>',
    });
    let imagePos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "image") imagePos = pos;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, imagePos)),
    );
    const imageContext: BubbleContext = {
      id: "image",
      anchor: "node-top",
      accessibleName: () => "Image controls",
      match: (currentEditor) =>
        currentEditor.state.selection instanceof NodeSelection
          ? { from: imagePos, to: imagePos + 1, nodePos: imagePos, identity: "image" }
          : null,
      Component: () => null,
    };

    expect(selectBubbleContext(editor, [linkBubbleContext, imageContext])?.context.id).toBe(
      "image",
    );
    expect(matchLinkEntry(editor)).toBeNull();
  });

  it("declines code schemas that do not expose the link mark", () => {
    editor = new Editor({
      extensions: createStandaloneEditorExtensions({ schemaType: "code" }),
      content: "plain code",
    });
    editor.commands.selectAll();

    expect(editor.schema.marks.link).toBeUndefined();
    expect(matchExistingLink(editor)).toBeNull();
    expect(matchLinkEntry(editor)).toBeNull();
  });

  it("declines both passive and explicit entry when read-only", () => {
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: '<p><a href="https://example.com">linked</a></p>',
      editable: false,
    });
    editor.commands.setTextSelection(3);

    expect(editor.isEditable).toBe(false);
    expect(matchExistingLink(editor)).toBeNull();
    expect(matchLinkEntry(editor)).toBeNull();
  });
});
