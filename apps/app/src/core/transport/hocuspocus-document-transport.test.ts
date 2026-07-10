import { describe, expect, it } from "vitest";

import { parseSafetyNotice } from "./hocuspocus-document-transport";

describe("Hocuspocus document safety notices", () => {
  it("accepts the defined safety_notice stateless payload", () => {
    expect(
      parseSafetyNotice(
        JSON.stringify({
          type: "safety_notice",
          documentId: "document-1",
          kind: "checkpoint_sweep",
          message: "Content was modified — View change",
          data: { beforeContentRef: 42 },
        }),
      ),
    ).toEqual({
      type: "safety_notice",
      documentId: "document-1",
      kind: "checkpoint_sweep",
      message: "Content was modified — View change",
      data: { beforeContentRef: 42 },
    });
  });

  it("ignores malformed stateless payloads", () => {
    expect(parseSafetyNotice("not json")).toBeNull();
    expect(parseSafetyNotice(JSON.stringify({ type: "other" }))).toBeNull();
  });
});
