/** Authoritative inline, desktop, and mobile recovery-host demand proofs. */
import { describe, expect, it } from "vitest";
import { postApplyHostDemandKey, postApplyHostRequired } from "./ProjectDraftApplyRecoveryExecutor";

const base = {
  documentId: "doc-1",
  inlineDocumentIds: [] as string[],
  desktopHostDocumentIds: [] as string[],
  mobileHostDocumentId: null,
};

describe("post-Apply host demand", () => {
  it("requires surviving Chat inline review after its normal tab closes", () => {
    expect(postApplyHostRequired({ ...base, inlineDocumentIds: ["doc-1"] })).toBe(true);
  });

  it("requires surviving Editor inline review without a tracked tab", () => {
    expect(postApplyHostRequired({ ...base, inlineDocumentIds: ["doc-1"] })).toBe(true);
  });

  it("does not treat a persisted desktop tab as mounted on phone", () => {
    expect(postApplyHostRequired(base)).toBe(false);
  });

  it("changes demand revision input when the desktop host subtree mounts or unmounts", () => {
    expect(
      postApplyHostDemandKey({
        inlineDocumentIds: [],
        desktopHostDocumentIds: [],
        mobileHostDocumentId: null,
      }),
    ).not.toBe(
      postApplyHostDemandKey({
        inlineDocumentIds: [],
        desktopHostDocumentIds: ["doc-1"],
        mobileHostDocumentId: null,
      }),
    );
  });
});
