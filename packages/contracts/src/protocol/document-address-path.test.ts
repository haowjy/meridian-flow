/** Review selectors belong only to the optional browser-address request. */
import { expect, it } from "vitest";
import { apiProjectDocumentAddressPath } from "./paths.js";

it("serializes the Work and item selector without changing the manuscript owner", () => {
  const address = apiProjectDocumentAddressPath("project", "manuscript", "chapters/one", {
    workId: null,
    review: { workId: "review-work", itemKey: "branch:document" },
  });
  const query = new URL(address, "https://example.test").searchParams;
  expect(Object.fromEntries(query)).toEqual({
    path: "chapters/one",
    reviewWorkId: "review-work",
    itemKey: "branch:document",
  });
  expect(
    apiProjectDocumentAddressPath("project", "manuscript", "chapters/one", { workId: null }),
  ).toBe("/api/projects/project/context/manuscript/address?path=chapters%2Fone");
});
