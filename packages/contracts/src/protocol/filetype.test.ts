/**
 * Purpose: Contract coverage for canonical filetype derivation helpers.
 *
 * Key decision: `Filetype` remains the source of truth for viewer/editor
 * surface; `DocumentFileType` is derived only when persisted/serialized as a
 * storage class.
 */
import { describe, expect, it } from "vitest";

import { documentFileTypeFor, type Filetype } from "./filetype";

describe("documentFileTypeFor", () => {
  it.each([
    ["markdown", null],
    ["python", null],
    ["typescript", null],
    ["javascript", null],
    ["json", null],
    ["shell", null],
    ["yaml", null],
    ["text", null],
    ["csv", null],
    ["notebook", null],
    ["pdf", "pdf"],
    ["png", "image"],
    ["jpg", "image"],
    ["svg", "image"],
  ] satisfies Array<
    [Filetype, ReturnType<typeof documentFileTypeFor>]
  >)("derives %s filetype to %s", (filetype, expected) => {
    expect(documentFileTypeFor({ filetype, mimeType: "" })).toBe(expected);
  });

  it("derives docx from MIME because docx is not a Filetype", () => {
    expect(
      documentFileTypeFor({
        filetype: null,
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=binary",
      }),
    ).toBe("docx");
  });

  it("derives storage class from MIME when filetype is null", () => {
    expect(documentFileTypeFor({ filetype: null, mimeType: "" })).toBe("binary");
    expect(documentFileTypeFor({ filetype: null, mimeType: "application/octet-stream" })).toBe(
      "binary",
    );
    expect(documentFileTypeFor({ filetype: null, mimeType: "image/webp" })).toBe("image");
    expect(documentFileTypeFor({ filetype: null, mimeType: "application/pdf" })).toBe("pdf");
  });
});
