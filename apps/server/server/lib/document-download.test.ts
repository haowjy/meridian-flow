/** Downloads derive the file suffix from the persisted document type. */
import { describe, expect, it } from "vitest";
import { exportFilename as attachmentFilename } from "../domains/context/index.js";
import { attachmentDisposition } from "./attachment-disposition.js";

describe("document download names", () => {
  it("adds md to prose, preserves dots and leaves other stored names alone", () => {
    expect(attachmentFilename("Chapter 13", "", "markdown")).toBe("Chapter 13.md");
    expect(attachmentFilename("Vol. 2", "", "markdown")).toBe("Vol. 2.md");
    expect(attachmentFilename("outline", "json", "json")).toBe("outline.json");
    expect(attachmentFilename("Pic", "png", "image")).toBe("Pic.png");
    expect(attachmentFilename("LICENSE", "", "binary")).toBe("LICENSE");
    expect(attachmentDisposition("Chapter 13.md")).toBe(
      "attachment; filename=\"Chapter 13.md\"; filename*=UTF-8''Chapter%2013.md",
    );
    expect(attachmentDisposition("章节 13.md")).toBe(
      "attachment; filename=\"__ 13.md\"; filename*=UTF-8''%E7%AB%A0%E8%8A%82%2013.md",
    );
  });
});
