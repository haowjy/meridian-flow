/** The catalogs a scope's document index walks. */

import { describe, expect, it } from "vitest";

import { LINKABLE_SCHEMES, linkableCatalogScopes } from "./linkable-catalog-scopes";

describe("linkableCatalogScopes", () => {
  it("offers Unfiled with or without a Work, as the project catalog always holds it", () => {
    expect(LINKABLE_SCHEMES).toContain("unfiled");
    expect(
      linkableCatalogScopes({ projectId: "project-1", workId: "work-1", noWorkId: "no-work" }),
    ).toEqual({ projectId: "project-1", workId: "work-1" });
  });

  it("reads Scratch and Uploads from the No Work row when no Work is selected", () => {
    expect(
      linkableCatalogScopes({ projectId: "project-1", workId: null, noWorkId: "no-work" }),
    ).toEqual({ projectId: "project-1", workId: "no-work" });
  });

  it("leaves Scratch and Uploads unasked until the No Work row is known", () => {
    expect(linkableCatalogScopes({ projectId: "project-1", workId: null, noWorkId: null })).toEqual(
      { projectId: "project-1", workId: null },
    );
  });

  it("asks nothing without a project", () => {
    expect(linkableCatalogScopes({ projectId: null, workId: "work-1", noWorkId: null })).toBeNull();
  });
});
