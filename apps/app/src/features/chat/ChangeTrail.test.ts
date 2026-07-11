import { describe, expect, it } from "vitest";
import type { TrailChange } from "@/client/change-trails";
import { changePresentation } from "./ChangeTrail";

const change = (overrides: Partial<TrailChange>): TrailChange => ({
  changeId: "change-1",
  ordinal: 0,
  documentId: "document-1",
  kind: "modify",
  beforeText: "receipt text",
  afterTextAtReceipt: "after",
  navigation: { kind: "unavailable", reason: "fixture" },
  swept: null,
  reversible: false,
  ...overrides,
});

describe("change trail presentation matrix", () => {
  it("never substitutes receipt text for an unavailable swept body", () => {
    expect(
      changePresentation(
        change({ swept: { removed: { status: "unavailable", reason: "capture_failed" } } }),
        null,
      ),
    ).toMatchObject({ earlierText: null, earlierUnavailable: true });
  });

  it("does not claim ordinary insert content was unrecoverable", () => {
    expect(changePresentation(change({ kind: "insert", beforeText: null }), null)).toMatchObject({
      earlierText: null,
      earlierUnavailable: false,
    });
  });

  it("shows delete success only after navigation resolves", () => {
    const deletion = change({ kind: "delete" });
    expect(changePresentation(deletion, null).deleteResolved).toBe(false);
    expect(changePresentation(deletion, { kind: "shown", currentText: null }).deleteResolved).toBe(
      true,
    );
  });
});
