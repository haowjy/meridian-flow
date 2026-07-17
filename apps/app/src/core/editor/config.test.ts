// @vitest-environment jsdom

import { getSchema } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  COLLABORATION_Y_UNDO_TRACKED_ORIGINS,
  createEditorConfig,
  createStandaloneEditorExtensions,
} from "./config";
import { REVIEW_APPLY_ORIGIN, REVIEW_DISCARD_ORIGIN } from "./review-origins";

describe("editor collaboration undo configuration", () => {
  it("keeps typing undo tracked while adding review apply/discard origins", () => {
    const fragment = new Y.Doc().getXmlFragment("prosemirror");
    const undoManager = new Y.UndoManager(fragment, {
      trackedOrigins: new Set([ySyncPluginKey, ...COLLABORATION_Y_UNDO_TRACKED_ORIGINS]),
    });

    expect(undoManager.trackedOrigins.has(ySyncPluginKey)).toBe(true);
    expect(undoManager.trackedOrigins.has(REVIEW_APPLY_ORIGIN)).toBe(true);
    expect(undoManager.trackedOrigins.has(REVIEW_DISCARD_ORIGIN)).toBe(true);
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

  it("lets the schema parse data URI images preserved by sanitization", () => {
    const schema = getSchema(createStandaloneEditorExtensions());
    const container = window.document.createElement("div");
    container.innerHTML = '<p><img src="data:image/png;base64,iVBORw0KGgo="></p>';

    const parsed = ProseMirrorDOMParser.fromSchema(schema).parse(container);

    expect(parsed.firstChild?.firstChild?.type.name).toBe("image");
    expect(parsed.firstChild?.firstChild?.attrs.src).toBe("data:image/png;base64,iVBORw0KGgo=");
  });
});
