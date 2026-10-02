/** Desktop Editor selection uses one route-first rule in every host owner. */

import { describe, expect, it } from "vitest";
import { activeEditorDocumentId } from "./active-editor-document";

describe("activeEditorDocumentId", () => {
  it("prefers the route-local document over the persisted tab selection", () => {
    expect(activeEditorDocumentId("local", "selected")).toBe("local");
  });

  it("falls back to the persisted tab selection", () => {
    expect(activeEditorDocumentId(undefined, "selected")).toBe("selected");
  });
});
