/** Review admission requires both explicit branch intent and a resolved Work. */
import { apiProjectDocumentAddressPath } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { documentAddressReview } from "./document-address-review";

it("sends the selected Work and per-document branch", () => {
  expect(documentAddressReview("branch-a", "work-a")).toEqual({
    workId: "work-a",
    draftBranchId: "branch-a",
  });
  const url = apiProjectDocumentAddressPath("project-a", "kb", "hidden.md", {
    workId: null,
    review: documentAddressReview("branch-a", "work-a"),
  });
  expect(url).toContain("reviewWorkId=work-a");
  expect(url).toContain("draftBranchId=branch-a");
});

it.each([
  [undefined, "work-a"],
  ["branch-a", null],
  [undefined, null],
] as const)("omits review authority without draft %s or Work %s", (draftId, workId) => {
  expect(documentAddressReview(draftId, workId)).toBeUndefined();
  const url = apiProjectDocumentAddressPath("project-a", "kb", "hidden.md", {
    workId: null,
    review: documentAddressReview(draftId, workId),
  });
  expect(url).not.toContain("review");
});
