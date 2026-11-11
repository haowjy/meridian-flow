import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { resolveWorkspaceRoute } from "./context-route-workspace-owner";

const tracked = (
  id: string,
  path: string,
  workId: string,
  origin?: "local-resource",
): Extract<ContextTab, { kind: "tracked" }> => ({
  kind: "tracked",
  documentId: id,
  scheme: "scratch",
  path,
  name: path,
  workId,
  editable: true,
  filetype: "markdown",
  schemaType: "document",
  ...(origin ? { origin } : {}),
});

describe("resolveWorkspaceRoute", () => {
  it("never lets another tab own the route by its path while the bound document has no tab", () => {
    expect(
      resolveWorkspaceRoute({
        tabs: [tracked("other", "/old.md", "a")],
        selectedDocumentId: "other",
        locator: { scheme: "scratch", path: "/old.md", workId: "a" },
        boundDocumentId: "doc",
      }),
    ).toEqual({ kind: "unowned" });
  });
  it("matches exact server scheme, path, and Work", () => {
    expect(
      resolveWorkspaceRoute({
        tabs: [tracked("a", "/same.md", "a"), tracked("b", "/same.md", "b")],
        selectedDocumentId: "a",
        locator: { scheme: "scratch", path: "/same.md", workId: "b" },
      }),
    ).toMatchObject({ kind: "owner", tab: { documentId: "b" } });
  });
});
