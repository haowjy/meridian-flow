/**
 * Composer document behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - composer draft selection mapping
 */
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

it("projects unique owned uploads in occurrence order without changing the submitted message", () => {
  const upload = {
    intakeId: "intake-1",
    documentId: "doc-1",
    uri: "kb://notes.md",
    locationRevision: "rev-1",
  };
  const reference = {
    kind: "document",
    documentId: upload.documentId,
    uri: upload.uri,
    label: "notes",
    imageCapable: false,
    upload: null,
  };
  const doc = plainComposerDoc("Compare ");
  doc.content?.[0]?.content?.push(
    ...[reference, { ...reference, upload }, { ...reference, upload }].map((value) => ({
      type: "composerReference",
      attrs: { reference: value },
    })),
  );
  const message = serializeComposerDraft(doc, 7, { anchor: 2, head: 2 });
  expect(message.draft).toEqual({
    doc,
    revision: 7,
    selection: { anchor: 2, head: 2 },
    ownedUploads: [upload],
  });
  expect(message.text).toBe(
    "Compare [notes](kb://notes.md)[notes](kb://notes.md)[notes](kb://notes.md)",
  );
  expect(message.references).toEqual([
    {
      kind: "document",
      documentId: upload.documentId,
      uri: upload.uri,
      purpose: "draft-upload",
      intakeId: upload.intakeId,
    },
  ]);
});
