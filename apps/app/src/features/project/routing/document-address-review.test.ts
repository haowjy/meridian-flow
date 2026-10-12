/** Review admission requires both explicit branch intent and a resolved Work. */
import { expect, it } from "vitest";
import { bindDocumentAddressReview, reviewAddressRouteBinding } from "./document-address-review";

// A review must bind before any catalog path occupant can participate.
it("waits for branch identity and then sends it, independent of the live path", () => {
  expect(
    bindDocumentAddressReview("branch-a", "work-a", { status: "loading", groups: null }),
  ).toEqual({ kind: "pending" });
  expect(
    bindDocumentAddressReview("branch-a", "work-a", {
      status: "ready",
      groups: [{ documentId: "hidden", draft: { draftId: "branch-a" } }] as never,
    }),
  ).toEqual({
    kind: "review",
    review: { workId: "work-a", draftBranchId: "branch-a", documentId: "hidden" },
  });
  expect(
    bindDocumentAddressReview(undefined, "work-a", { status: "loading", groups: null }),
  ).toEqual({ kind: "plain" });
  expect(bindDocumentAddressReview("missing", "work-a", { status: "empty", groups: [] })).toEqual({
    kind: "unavailable",
  });
});

it("replaces a cold live path binding only after the selected review identity is admitted", () => {
  const binding = {
    kind: "review" as const,
    review: { workId: "work", draftBranchId: "branch", documentId: "hidden" },
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
