/** Review admission requires both explicit draft intent and a resolved Work. */
import { expect, it } from "vitest";
import { bindDocumentAddressReview } from "./document-address-review";

it("starts review admission with the selected Work and draft, without draft-list identity", () => {
  expect(bindDocumentAddressReview("draft-a", "work:work-a")).toEqual({
    kind: "review",
    review: { owner: "work:work-a", itemKey: "draft-a" },
  });
  expect(bindDocumentAddressReview("missing", "work:work-a")).toEqual({
    kind: "review",
    review: { owner: "work:work-a", itemKey: "missing" },
  });
  expect(bindDocumentAddressReview("draft-a", null)).toEqual({ kind: "pending" });
  expect(bindDocumentAddressReview(undefined, "work:work-a")).toEqual({ kind: "plain" });
});

it("starts a cold copied URL's selector read while the list is unresolved and round trips transport", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const { apiProjectDocumentAddressPath } = await import("@meridian/contracts/protocol");
  const { parseProjectAddress } = await import("./project-address");
  const { documentAddressQueryOptions } = await import("./document-address-review");
  const projectId = "550e8400-e29b-41d4-a716-446655440000";
  const workId = "123e4567-e89b-42d3-a456-426614174000";
  const owner = `work:${workId}`;
  const itemKey = "branch:document";
  const address = parseProjectAddress(
    `/p/${projectId}/editor/kb/Old.md`,
    `?owner=${owner}&item=${encodeURIComponent(itemKey)}&change=class%3Apart`,
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
      binding: bindDocumentAddressReview(address.address.itemKey, owner),
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
      ["reviewOwner", owner],
      ["itemKey", itemKey],
    ]);
    for (const binding of [
      bindDocumentAddressReview("other-item", owner),
      bindDocumentAddressReview(itemKey, "work:other-work"),
    ]) {
      expect(
        documentAddressQueryOptions(
          {
            projectId,
            destination: address.address.destination,
            owner: {},
            binding,
          },
          read,
        ).queryKey,
      ).not.toEqual(options.queryKey);
    }
  } finally {
    client.clear();
  }
});
