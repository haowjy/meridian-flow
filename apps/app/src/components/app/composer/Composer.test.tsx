/** Ordered serialization contracts for the shared TipTap Composer. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({ t: (value: TemplateStringsArray) => value.join("") }));
vi.mock("./placeholders", () => ({ useComposerPlaceholder: () => "Write" }));
vi.stubGlobal("crypto", { randomUUID: () => "submission-1" });

import { type ComposerOwnedUpload, serializeComposerDraft } from "./Composer";
import { mergeComposerDraftSnapshots } from "./composer-document";

const reference = {
  documentId: "01900000-0000-7000-8000-000000000001",
  uri: "uploads://@/Gate Map.png",
  fileType: "image",
  authority: { kind: "none", projectId: "project-1" },
  label: "Gate Map",
  spelling: "[[Gate Map]]",
  imageCapable: true,
  upload: null as ComposerOwnedUpload | null,
};
const token = (attrs = reference) => ({ type: "composerReference", attrs: { reference: attrs } });
describe("one ordered Composer serializer", () => {
  it("preserves paragraphs, hard breaks, typed prose, and duplicate occurrences", () => {
    const result = serializeComposerDraft(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Compare " },
              token(),
              { type: "hardBreak" },
              { type: "text", text: "with " },
              token(),
            ],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "uploads://@/Gate Map.png and [[Gate Map]]" }],
          },
        ],
      },
      7,
      { anchor: 3, head: 9 },
    );
    expect(result.text).toBe(
      "Compare [[Gate Map]]\nwith [[Gate Map]]\nuploads://@/Gate Map.png and [[Gate Map]]",
    );
    expect(result.blocks.filter((b) => b.type === "reference")).toHaveLength(2);
    expect(result.blocks.filter((b) => b.type === "image")).toHaveLength(2);
    expect(result.references).toHaveLength(1);
    expect(
      result.blocks
        .filter((b) => b.type === "text" || b.type === "reference")
        .map((b) => b.text)
        .join(""),
    ).toBe(result.text);
    expect(result.draft.selection).toEqual({ anchor: 3, head: 9 });
    expect(result.acceptedRevision).toBe(7);
  });
  it("gives created provenance precedence and retains deletion identity", () => {
    const upload = {
      intakeId: "intake-1",
      documentId: reference.documentId,
      uri: reference.uri,
      locationRevision: "r1",
    };
    const result = serializeComposerDraft({
      type: "doc",
      content: [{ type: "paragraph", content: [token(), token({ ...reference, upload })] }],
    });
    expect(result.references).toEqual([
      {
        documentId: reference.documentId,
        uri: reference.uri,
        purpose: "draft-upload",
        intakeId: "intake-1",
      },
    ]);
    expect(result.draft.ownedUploads).toEqual([upload]);
  });
  it("never adopts pending or failed placeholders", () => {
    const result = serializeComposerDraft({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "before" },
            {
              type: "composerUpload",
              attrs: { upload: { intakeId: "i", name: "x", state: "failed", error: "no" } },
            },
            { type: "text", text: "after" },
          ],
        },
      ],
    });
    expect(result.text).toBe("beforeafter");
    expect(result.references).toEqual([]);
  });
});

describe("document-level failed submission merge", () => {
  it("preserves duplicate atoms, upload rights, hard breaks, equal text, and later selection", () => {
    const upload = {
      intakeId: "intake-1",
      documentId: reference.documentId,
      uri: reference.uri,
      locationRevision: "r1",
    };
    const submitted = serializeComposerDraft(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              token({ ...reference, upload }),
              { type: "hardBreak" },
              token({ ...reference, upload }),
            ],
          },
        ],
      },
      4,
      { anchor: 2, head: 1 },
    ).draft;
    const later = serializeComposerDraft(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              token({ ...reference, upload }),
              { type: "hardBreak" },
              token({ ...reference, upload }),
            ],
          },
        ],
      },
      5,
      { anchor: 3, head: 2 },
    ).draft;
    const merged = mergeComposerDraftSnapshots(submitted, later);
    expect(merged.doc.content).toHaveLength(3);
    expect(JSON.stringify(merged.doc).match(/composerReference/g)).toHaveLength(4);
    expect(merged.ownedUploads).toEqual([upload]);
    expect(merged.selection.anchor).toBeGreaterThan(later.selection.anchor);
    expect(merged.selection.anchor - merged.selection.head).toBe(1);
  });
});
