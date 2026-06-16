import { describe, expect, it } from "vitest";

import {
  figureDefaultAltFromFilename,
  figureNodeAttrsFromReference,
  isImageFile,
  signedUrlRefreshDelayMs,
  uploadResponseToFigureNodeAttrs,
} from "./figure-workflow";

describe("figure workflow helpers", () => {
  it("recognizes image MIME types and common image extensions", () => {
    expect(isImageFile({ name: "scan.png", type: "image/png" } as File)).toBe(true);
    expect(isImageFile({ name: "scan.webp", type: "" } as File)).toBe(true);
    expect(isImageFile({ name: "notes.txt", type: "text/plain" } as File)).toBe(false);
  });

  it("derives readable default alt text from a filename", () => {
    expect(figureDefaultAltFromFilename("dose_response-gel.png")).toBe("dose response gel");
    expect(figureDefaultAltFromFilename(".png")).toBe(".png");
  });

  it("coerces the upload response figure reference into exact node attrs", () => {
    const attrs = uploadResponseToFigureNodeAttrs({
      documentId: "doc-1",
      storageUrl: "object://meridian/figures/p/doc/a.png",
      mimeType: "image/png",
      fileType: "image",
      sizeBytes: 123,
      signedUrl: "/api/object-store/local/token",
      signedUrlExpiresAt: "2026-06-04T12:15:00.000Z",
      figure: {
        src: "object://meridian/figures/p/doc/a.png",
        alt: "Gel image",
        label: "fig:gel",
        caption: null,
      },
    });

    expect(attrs).toEqual({
      src: "object://meridian/figures/p/doc/a.png",
      alt: "Gel image",
      label: "fig:gel",
      caption: "",
    });
  });

  it("preserves nullable label/alt and caption attr defaults", () => {
    expect(
      figureNodeAttrsFromReference({
        src: "object://meridian/figures/p/doc/a.png",
        alt: "",
        label: null,
        caption: "Caption text",
      }),
    ).toEqual({
      src: "object://meridian/figures/p/doc/a.png",
      alt: null,
      label: null,
      caption: "Caption text",
    });
  });

  it("refreshes signed URLs before expiry without writing signed URLs into node attrs", () => {
    const now = Date.parse("2026-06-04T12:00:00.000Z");
    expect(signedUrlRefreshDelayMs("2026-06-04T12:15:00.000Z", now)).toBe(870_000);
    expect(signedUrlRefreshDelayMs("2026-06-04T12:00:20.000Z", now)).toBe(0);
  });
});
