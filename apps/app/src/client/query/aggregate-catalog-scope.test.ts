import { describe, expect, it } from "vitest";
import { aggregateCatalogScope } from "./useContextCatalog";

describe("a link index's catalogs", () => {
  it("reads a lineage's Scratch with the lineage and its Uploads with the Work row", () => {
    const owners = { workId: "no-work", rootThreadId: "root", uploadsWorkId: "no-work" };
    expect(aggregateCatalogScope("project", "scratch", owners)).toEqual({
      kind: "lineage",
      projectId: "project",
      rootThreadId: "root",
    });
    // A scheme with no scope stays incomplete forever, which would refuse the whole index.
    expect(aggregateCatalogScope("project", "uploads", owners)).toEqual({
      kind: "work",
      projectId: "project",
      workId: "no-work",
    });
  });

  it("reads a Work's Scratch and Uploads from that Work", () => {
    const owners = { workId: "arc", uploadsWorkId: "arc" };
    for (const scheme of ["scratch", "uploads"] as const)
      expect(aggregateCatalogScope("project", scheme, owners)).toMatchObject({
        kind: "work",
        workId: "arc",
      });
  });
});
