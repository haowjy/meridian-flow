import { describe, expect, it } from "vitest";
import {
  MERIDIAN_CLIPBOARD_KIND,
  MERIDIAN_CLIPBOARD_VERSION,
  parseMeridianClipboardPayload,
  serializeMeridianClipboardPayload,
  type MeridianClipboardPayload,
} from "@/core/lib/meridianClipboard";

describe("meridianClipboard payload parsing", () => {
  it("returns null for malformed JSON", () => {
    expect(parseMeridianClipboardPayload("{")).toBeNull();
  });

  it("returns null for unsupported version", () => {
    const raw = JSON.stringify({
      kind: MERIDIAN_CLIPBOARD_KIND,
      version: 999,
      text: "\uFFFC",
      elements: [],
    });
    expect(parseMeridianClipboardPayload(raw)).toBeNull();
  });

  it("returns null for out-of-range element position", () => {
    const raw = JSON.stringify({
      kind: MERIDIAN_CLIPBOARD_KIND,
      version: MERIDIAN_CLIPBOARD_VERSION,
      text: "abc",
      elements: [{ position: 3, element: { type: "reference" } }],
    });
    expect(parseMeridianClipboardPayload(raw)).toBeNull();
  });

  it("parses version 2 payloads", () => {
    const payload: MeridianClipboardPayload = {
      kind: MERIDIAN_CLIPBOARD_KIND,
      version: MERIDIAN_CLIPBOARD_VERSION,
      text: "A\uFFFCC",
      elements: [
        {
          position: 1,
          element: {
            type: "reference",
            documentId: "doc-1",
            refType: "document",
            displayName: "Doc 1",
            documentPath: "docs/doc-1.md",
          },
        },
      ],
    };

    const parsed = parseMeridianClipboardPayload(
      serializeMeridianClipboardPayload(payload),
    );

    expect(parsed).toEqual(payload);
  });

  it("normalizes version 1 references into version 2 elements", () => {
    const raw = JSON.stringify({
      kind: MERIDIAN_CLIPBOARD_KIND,
      version: 1,
      text: "A\uFFFCC",
      references: [
        {
          position: 1,
          documentId: "doc-legacy",
          refType: "document",
          displayName: "Legacy Doc",
          documentPath: "legacy/doc.md",
        },
      ],
    });

    const parsed = parseMeridianClipboardPayload(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({
      kind: MERIDIAN_CLIPBOARD_KIND,
      version: MERIDIAN_CLIPBOARD_VERSION,
      text: "A\uFFFCC",
      elements: [
        {
          position: 1,
          element: {
            type: "reference",
            documentId: "doc-legacy",
            refType: "document",
            displayName: "Legacy Doc",
            documentPath: "legacy/doc.md",
          },
        },
      ],
    });
  });
});
