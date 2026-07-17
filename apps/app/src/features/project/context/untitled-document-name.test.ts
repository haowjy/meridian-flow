import { describe, expect, it } from "vitest";
import { suggestedUntitledDocumentName } from "./untitled-document-name";

const content = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("untitled document name suggestion", () => {
  it("slugifies only the first line", () => {
    expect(suggestedUntitledDocumentName(content("The Azure Gate!\nSecond line"))).toBe(
      "the-azure-gate",
    );
  });

  it("uses the temp label until the document has text", () => {
    expect(suggestedUntitledDocumentName({ type: "doc" })).toBe("");
  });

  it("does not borrow a later paragraph when the first line is empty", () => {
    const document = {
      type: "doc",
      content: [
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "Later line" }] },
      ],
    };
    expect(suggestedUntitledDocumentName(document)).toBe("");
  });
});
