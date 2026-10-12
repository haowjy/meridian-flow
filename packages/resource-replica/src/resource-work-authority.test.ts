/** Known project identities, rather than missing slugs, decide No Work. */
import { expect, it } from "vitest";
import { resourceContextAuthority, resourceWorkAuthorityFor } from "./resource-work-authority";

it("constructs No Work only from the locked row and requires named Work slugs", () => {
  expect(resourceWorkAuthorityFor("none", { works: [], noWork: { id: "none" } })).toEqual({
    workId: "none",
    workSlug: null,
  });
  expect(() =>
    resourceWorkAuthorityFor("named", {
      works: [{ id: "named", slug: null }],
      noWork: { id: "none" },
    }),
  ).toThrow();
  const named = resourceWorkAuthorityFor("named", {
    works: [{ id: "named", slug: "alpha" }],
    noWork: { id: "none" },
  });
  expect(resourceContextAuthority("scratch", named)).toEqual({ kind: "work", workSlug: "alpha" });
  expect(() => resourceContextAuthority("scratch", { workId: null })).toThrow();
});
