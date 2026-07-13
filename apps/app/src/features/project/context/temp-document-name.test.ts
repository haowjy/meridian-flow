import { describe, expect, it } from "vitest";
import {
  initialTempDocumentName,
  takeTempDocumentNameOwnership,
  updateSuggestedTempDocumentName,
} from "./temp-document-name";

const content = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("temporary document save names", () => {
  it("starts from the slugified first line and follows it while unowned", () => {
    const initial = initialTempDocumentName(content("The Azure Gate!\nSecond line"), "Untitled");
    expect(initial).toEqual({ value: "the-azure-gate", owned: false });
    expect(updateSuggestedTempDocumentName(initial, content("Salt & Iron"))).toEqual({
      value: "salt-iron",
      owned: false,
    });
  });

  it("uses the temp label until the document has text", () => {
    expect(initialTempDocumentName({ type: "doc" }, "Untitled 2")).toEqual({
      value: "Untitled 2",
      owned: false,
    });
  });

  it("does not borrow a later paragraph when the first line is empty", () => {
    const document = {
      type: "doc",
      content: [
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "Later line" }] },
      ],
    };
    expect(initialTempDocumentName(document, "Untitled").value).toBe("Untitled");
  });

  it("permanently stops suggestions after the first manual edit", () => {
    const owned = takeTempDocumentNameOwnership(
      initialTempDocumentName(content("Draft"), "Untitled"),
      "my-chapter",
    );
    expect(updateSuggestedTempDocumentName(owned, content("A changed opening"))).toEqual({
      value: "my-chapter",
      owned: true,
    });
  });
});
