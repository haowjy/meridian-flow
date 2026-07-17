import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { untitledDocumentIsEmpty, untitledHomeUri } from "./untitled-reconciler";

describe("untitled document decisions", () => {
  it("resolves the default work scratch root through one seam", () => {
    expect(untitledHomeUri("project-1", "work-1")).toEqual({
      scheme: "scratch",
      workId: "work-1",
    });
    expect(untitledHomeUri("project-1", null)).toBeNull();
  });

  it("treats the editor's structural empty paragraph as empty", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("prosemirror");
    const paragraph = new Y.XmlElement("paragraph");
    fragment.insert(0, [paragraph]);

    expect(untitledDocumentIsEmpty(fragment)).toBe(true);

    paragraph.insert(0, [new Y.XmlText("words")]);
    expect(untitledDocumentIsEmpty(fragment)).toBe(false);
  });

  it("treats non-text editor atoms as content", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("prosemirror");
    fragment.insert(0, [new Y.XmlElement("figure")]);

    expect(untitledDocumentIsEmpty(fragment)).toBe(false);
  });
});
