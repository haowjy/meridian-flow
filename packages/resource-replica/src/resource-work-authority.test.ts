/** Known project identities, rather than missing handles, decide No Work. */
import { expect, it } from "vitest";
import { resourceContextAuthority, resourceWorkAuthorityFor } from "./resource-work-authority";

it("constructs No Work only from the locked row and requires named Work handles", () => {
  expect(resourceWorkAuthorityFor("none", { works: [], noWork: { id: "none" } })).toEqual({
    workId: "none",
    workHandle: null,
  });
  expect(() =>
    resourceWorkAuthorityFor("named", {
      works: [{ id: "named", handle: null }],
      noWork: { id: "none" },
    }),
  ).toThrow();
  const named = resourceWorkAuthorityFor("named", {
    works: [{ id: "named", handle: "w1" }],
    noWork: { id: "none" },
  });
  expect(resourceContextAuthority("scratch", named)).toEqual({ kind: "work", workHandle: "w1" });
  expect(() => resourceContextAuthority("scratch", { workId: null })).toThrow();
});
