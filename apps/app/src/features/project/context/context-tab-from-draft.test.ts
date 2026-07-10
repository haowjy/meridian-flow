import { describe, expect, it } from "vitest";

import { contextTabFromDraftGroup } from "./context-tab-from-draft";

describe("contextTabFromDraftGroup", () => {
  it("synthesizes an editable manuscript tab for a markdown draft path", () => {
    expect(
      contextTabFromDraftGroup({
        documentId: "doc-1",
        contextPath: "/chapter-4.md",
        documentName: "chapter-4",
      }),
    ).toEqual({
      documentId: "doc-1",
      scheme: "manuscript",
      // Leading-slash tree path convention — must match the route's `path`
      // param exactly for findContextTabForRoute to resolve the tab.
      path: "/chapter-4.md",
      // Tab names carry the extension (tree nameFromPath convention), unlike
      // the extension-less documentName.
      name: "chapter-4.md",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    });
  });

  it("keeps folder context in the path but not the name", () => {
    const tab = contextTabFromDraftGroup({
      documentId: "doc-2",
      contextPath: "/arc-2/chapter-11.md",
    });
    expect(tab?.path).toBe("/arc-2/chapter-11.md");
    expect(tab?.name).toBe("chapter-11.md");
  });

  it("marks tabs for draft-created documents draftOnly", () => {
    const tab = contextTabFromDraftGroup({
      documentId: "doc-5",
      contextPath: "/new-doc.md",
      isNewDocument: true,
    });
    expect(tab?.draftOnly).toBe(true);
    // Existing documents never get the marker — discard must not close them.
    const existing = contextTabFromDraftGroup({
      documentId: "doc-6",
      contextPath: "/existing.md",
      isNewDocument: false,
    });
    expect(existing).not.toHaveProperty("draftOnly");
  });

  it("returns null without a contextPath (non-manuscript drafts)", () => {
    expect(contextTabFromDraftGroup({ documentId: "doc-3", contextPath: null })).toBeNull();
    expect(contextTabFromDraftGroup({ documentId: "doc-3" })).toBeNull();
  });

  it("returns null for paths with no Yjs editor surface", () => {
    expect(contextTabFromDraftGroup({ documentId: "doc-4", contextPath: "/cover.png" })).toBeNull();
  });
});
