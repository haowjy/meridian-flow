import { getSchema } from "@tiptap/core";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { COLLABORATION_Y_UNDO_TRACKED_ORIGINS, createStandaloneEditorExtensions } from "./config";
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
