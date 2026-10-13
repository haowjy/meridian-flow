/** Warm destination changes must not be mistaken for exiting the destination's own review. */
import { expect, it } from "vitest";
import { exitedReviewOwnsAddress } from "./review-address-ownership";

const owned = { workId: "work-a", documentId: "document-a", itemKey: "draft-a", locator: null };

it("clears the request when the owned review exits at the same address", () => {
  expect(exitedReviewOwnsAddress(owned, owned)).toBe(true);
});

it.each([
  { ...owned, documentId: "document-b", itemKey: "draft-b" },
  { ...owned, workId: "work-b" },
  { ...owned, documentId: "document-b" },
  { ...owned, itemKey: "draft-b" },
  { ...owned, documentId: null },
  { ...owned, documentId: undefined },
  { ...owned, itemKey: undefined },
])("preserves a different or unresolved destination request: %j", (address) => {
  // Without a confirmed owned locator, an unresolved identity cannot prove ownership.
  expect(exitedReviewOwnsAddress(owned, address)).toBe(false);
});

it("clears Exit before identity settles using the confirmed owned locator", () => {
  const locator = { scheme: "kb" as const, path: "/Withern" };
  expect(
    exitedReviewOwnsAddress({ ...owned, locator }, { ...owned, documentId: undefined, locator }),
  ).toBe(true);
});

it("clears Exit during a pending rename when the route still has its owned locator", () => {
  const locator = { scheme: "kb" as const, path: "/Before" };
  expect(
    exitedReviewOwnsAddress({ ...owned, locator }, { ...owned, documentId: null, locator }),
  ).toBe(true);
  expect(
    exitedReviewOwnsAddress(
      { ...owned, locator },
      { ...owned, documentId: null, locator: { ...locator, path: "/Other" } },
    ),
  ).toBe(false);
  expect(
    exitedReviewOwnsAddress(
      { ...owned, locator },
      { ...owned, documentId: owned.documentId, locator: { scheme: "user", path: "/Renamed" } },
    ),
  ).toBe(true);
});

it("preserves a warm Work or draft switch even at an identical unresolved locator", () => {
  const locator = { scheme: "kb" as const, path: "/Withern" };
  for (const address of [
    { ...owned, workId: "work-b" },
    { ...owned, itemKey: "draft-b" },
  ]) {
    expect(
      exitedReviewOwnsAddress(
        { ...owned, locator },
        { ...address, documentId: undefined, locator },
      ),
    ).toBe(false);
  }
});
