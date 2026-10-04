/** Known project identities, rather than missing slugs, decide No Work. */
import { expect, it } from "vitest";
import { resourceContextAuthority, resourceWorkAuthorityFor } from "./resource-work-authority";

it("constructs No Work only from the locked row and requires named Work slugs", () => {
  expect(resourceWorkAuthorityFor("none", [], "none")).toEqual({ workId: "none", workSlug: null });
  expect(() => resourceWorkAuthorityFor("named", [{ id: "named", slug: null }], "none")).toThrow();
  const named = resourceWorkAuthorityFor("named", [{ id: "named", slug: "alpha" }], "none");
  expect(resourceContextAuthority("scratch", named)).toEqual({ kind: "work", workSlug: "alpha" });
  expect(() => resourceContextAuthority("scratch", { workId: null })).toThrow();
});
