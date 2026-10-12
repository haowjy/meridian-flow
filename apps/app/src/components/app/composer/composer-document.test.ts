import { describe, expect, it } from "vitest";

import {
  parseRestorableComposerDraft,
  plainComposerDoc,
  serializeComposerDraft,
} from "./composer-document";

describe("restorable draft selection", () => {
  it("maps an end caret through multiple pending uploads", () => {
    const doc = plainComposerDoc("hi");
    doc.content?.[0]?.content?.push(
      ...["a", "b"].map((intakeId) => ({
        type: "composerUpload",
        attrs: { upload: { intakeId, name: "file", state: "pending", error: null } },
      })),
    );
    const restored = parseRestorableComposerDraft(
      serializeComposerDraft(doc, 1, { anchor: 5, head: 5 }).draft,
    );
    expect(restored?.doc).toEqual(plainComposerDoc("hi"));
    expect(restored?.selection).toEqual({ anchor: 3, head: 3 });
  });
  it("keeps prose and chooses a safe caret for a corrupt stored selection", () => {
    const restored = parseRestorableComposerDraft(
      serializeComposerDraft(plainComposerDoc("hi"), 1, { anchor: 9999, head: 9999 }).draft,
    );
    expect(restored?.doc).toEqual(plainComposerDoc("hi"));
    expect(restored?.selection).toEqual({ anchor: 1, head: 1 });
  });
});
