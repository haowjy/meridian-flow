// @vitest-environment jsdom
/** Editor configuration contracts at live-versus-review composition boundaries. */

import { getSchema } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createEditorConfig, createStandaloneEditorExtensions } from "./config";

describe("createEditorConfig", () => {
  it("keeps a draft review editor editable — the writer is one more peer in the draft room", () => {
    const document = new Y.Doc();

    const config = createEditorConfig({
      document,
      awareness: new Awareness(document),
      editable: true,
      enableDraftInlineReview: true,
    });

    expect(config.editable).toBe(true);
  });
});

describe("editor block layout schema", () => {
  it("exposes nullable align attrs on each alignable block", () => {
    const schema = getSchema(createStandaloneEditorExtensions());

    for (const nodeName of ["paragraph", "heading", "table"]) {
      expect(schema.nodes[nodeName]?.create().attrs.align).toBeNull();
    }
  });
});

describe("editor paste configuration", () => {
  it("sanitizes the final HTML after composing a caller transform", () => {
    const document = new Y.Doc();
    const config = createEditorConfig({
      document,
      awareness: new Awareness(document),
      editorProps: {
        transformPastedHTML: () => '<p onclick="alert(1)">safe</p><script>bad()</script>',
      },
    });

    const transform = config.editorProps?.transformPastedHTML;
    expect(transform).toBeDefined();
    expect(transform?.call(null, "ignored", {} as EditorView)).toBe("<p>safe</p>");
  });
});
