import { describe, expect, it } from "vitest";
import { aggregateCatalogScope } from "./useContextCatalog";

describe("a link index's catalogs", () => {
  it("reads a lineage's Scratch with the lineage and its uploads with the chat", () => {
    const owners = { workId: "no-work", rootThreadId: "root", chatId: "chat" };
    expect(aggregateCatalogScope("project", "scratch", owners)).toEqual({
      kind: "lineage",
      projectId: "project",
      rootThreadId: "root",
    });
    expect(aggregateCatalogScope("project", "uploads", owners)).toEqual({
      kind: "chat",
      projectId: "project",
      chatId: "chat",
    });
  });

  it("reads a Work's Scratch from that Work, and has no uploads outside a chat", () => {
    const owners = { workId: "arc" };
    expect(aggregateCatalogScope("project", "scratch", owners)).toMatchObject({
      kind: "work",
      workId: "arc",
    });
    expect(aggregateCatalogScope("project", "uploads", owners)).toBeNull();
  });
});
