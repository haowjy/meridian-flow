import { describe, expect, it } from "vitest";
import { dragPayloadKind, MERIDIAN_ENTRIES_MIME } from "./drag-payload";

describe("dragPayloadKind", () => {
  it("tells a row drag from a desktop file drag", () => {
    expect(dragPayloadKind(["Files"])).toBe("files");
    expect(dragPayloadKind([MERIDIAN_ENTRIES_MIME])).toBe("entries");
    expect(dragPayloadKind(["text/plain", "text/uri-list"])).toBe("none");
  });

  it("lets an internal drag win even if it ever carries files too", () => {
    expect(dragPayloadKind(["Files", MERIDIAN_ENTRIES_MIME])).toBe("entries");
  });
});
