/** Review admission requires both explicit branch intent and a resolved Work. */
import { expect, it } from "vitest";
import { bindDocumentAddressReview, reviewAddressRouteBinding } from "./document-address-review";

it("starts review admission with the selected Work and branch, without draft-list identity", () => {
  expect(bindDocumentAddressReview("branch-a", "work-a")).toEqual({
    kind: "review",
    review: { workId: "work-a", itemKey: "branch-a" },
  });
  expect(bindDocumentAddressReview("missing", "work-a")).toEqual({
    kind: "review",
    review: { workId: "work-a", itemKey: "missing" },
  });
  expect(bindDocumentAddressReview("branch-a", null)).toEqual({ kind: "pending" });
  expect(bindDocumentAddressReview(undefined, "work-a")).toEqual({ kind: "plain" });
});

it("replaces a cold live path binding only after the selected review identity is admitted", () => {
  const binding = {
    kind: "review" as const,
    review: { workId: "work", itemKey: "branch" },
  };
  const selection = {
    status: "bound" as const,
    revision: 2,
    locator: { scheme: "kb" as const, path: "/Withern", workId: "work" },
    identity: { kind: "server" as const, documentId: "live" },
  };
  const destination = { kind: "document" as const, scheme: "kb" as const, path: "Withern" };
  const result = {
    kind: "current",
    document: { documentId: "hidden" },
  } as import("@meridian/contracts/protocol").DocumentAddressResult;
  expect(reviewAddressRouteBinding(binding, result, selection, destination, "work")).toEqual({
    revision: 2,
    documentId: "hidden",
  });
  expect(
    reviewAddressRouteBinding({ kind: "pending" }, result, selection, destination, "work"),
  ).toBeNull();
  expect(reviewAddressRouteBinding(binding, undefined, selection, destination, "work")).toBeNull();
  expect(
    reviewAddressRouteBinding(
      binding,
      result,
      { ...selection, identity: { kind: "server", documentId: "hidden" } },
      destination,
      "work",
    ),
  ).toBeNull();
  expect(
    reviewAddressRouteBinding(binding, result, selection, destination, "other-work"),
  ).toBeNull();
});
