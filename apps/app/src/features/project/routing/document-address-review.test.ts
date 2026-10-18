/** Review admission requires both explicit draft intent and a resolved Work. */
import { expect, it } from "vitest";
import { bindDocumentAddressReview, reviewAddressRouteBinding } from "./document-address-review";

it("starts review admission with the selected Work and draft, without draft-list identity", () => {
  expect(bindDocumentAddressReview("draft-a", "work-a")).toEqual({
    kind: "review",
    review: { workId: "work-a", itemKey: "draft-a" },
  });
  expect(bindDocumentAddressReview("missing", "work-a")).toEqual({
    kind: "review",
    review: { workId: "work-a", itemKey: "missing" },
  });
  expect(bindDocumentAddressReview("draft-a", null)).toEqual({ kind: "pending" });
  expect(bindDocumentAddressReview(undefined, "work-a")).toEqual({ kind: "plain" });
});

it("replaces a cold live path binding only after the selected review identity is admitted", () => {
  const binding = {
    kind: "review" as const,
    review: { workId: "work", itemKey: "draft" },
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

it("starts a cold copied URL's selector read while the list is unresolved and round trips transport", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const { apiProjectDocumentAddressPath } = await import("@meridian/contracts/protocol");
  const { parseProjectAddress } = await import("./project-address");
  const { documentAddressQueryOptions } = await import("./document-address-review");
  const projectId = "550e8400-e29b-41d4-a716-446655440000";
  const workId = "123e4567-e89b-42d3-a456-426614174000";
  const itemKey = "branch:document";
  const address = parseProjectAddress(
    `/p/${projectId}/editor/kb/Old.md`,
    `?work=${workId}&item=${encodeURIComponent(itemKey)}&change=class%3Apart`,
  );
  if (address.kind !== "valid" || address.address.destination.kind !== "document")
    throw new Error("Expected a document address");
  expect(address.address).toMatchObject({ itemKey, changeId: "class:part" });
  let requested = "";
  const read = async (
    project: string,
    scheme: import("@meridian/contracts/protocol").ProjectContextTreeScheme,
    path: string,
    options?: import("@meridian/contracts/protocol").DocumentAddressRequestOptions,
  ) => {
    requested = apiProjectDocumentAddressPath(project, scheme, path, options);
    return {
      kind: "current",
      document: { documentId: "server-admitted" },
    } as import("@meridian/contracts/protocol").DocumentAddressResult;
  };
  const options = documentAddressQueryOptions(
    {
      projectId,
      destination: address.address.destination,
      owner: {},
      binding: bindDocumentAddressReview(address.address.itemKey, workId),
      workResolved: true,
    },
    read,
  );
  const client = new QueryClient();
  try {
    // Neither the options nor transport accepts a list; acquisition cannot hold up this request.
    const result = await client.fetchQuery(options);
    expect(result).toMatchObject({ document: { documentId: "server-admitted" } });
    expect([...new URL(requested, "https://app.test").searchParams.entries()]).toEqual([
      ["path", "Old.md"],
      ["reviewWorkId", workId],
      ["itemKey", itemKey],
    ]);
    for (const binding of [
      bindDocumentAddressReview("other-item", workId),
      bindDocumentAddressReview(itemKey, "other-work"),
    ]) {
      expect(
        documentAddressQueryOptions(
          {
            projectId,
            destination: address.address.destination,
            owner: {},
            binding,
            workResolved: true,
          },
          read,
        ).queryKey,
      ).not.toEqual(options.queryKey);
    }
  } finally {
    client.clear();
  }
});
