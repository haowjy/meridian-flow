/** Warm destination changes must not be mistaken for exiting the destination's own review. */
import { expect, it } from "vitest";
import { exitedReviewOwnsAddress } from "./review-address-ownership";

const owned = { workId: "work-a", documentId: "document-a", draftId: "draft-a" };

it("clears the request when the owned review exits at the same address", () => {
  expect(exitedReviewOwnsAddress(owned, owned)).toBe(true);
});

it.each([
  { ...owned, documentId: "document-b", draftId: "draft-b" },
  { ...owned, workId: "work-b" },
  { ...owned, documentId: "document-b" },
  { ...owned, draftId: "draft-b" },
  { ...owned, documentId: null },
  { ...owned, documentId: undefined },
  { ...owned, draftId: undefined },
])("preserves a different or unresolved destination request: %j", (address) => {
  // Scheme and path cannot establish ownership: identities survive cross-scheme moves.
  expect(exitedReviewOwnsAddress(owned, address)).toBe(false);
});
