import { describe, expect, it } from "vitest";
import { ownedLinkableSchemes } from "@/features/links/linkable-catalog-scopes";
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
    // The link index requests only owned catalogs, so an Editor document's index can complete.
    const editor = { projectId: "project", workId: "arc", rootThreadId: null, chatId: null };
    expect(ownedLinkableSchemes(editor)).not.toContain("uploads");
    expect(ownedLinkableSchemes({ ...editor, chatId: "chat" })).toContain("uploads");
  });
});
