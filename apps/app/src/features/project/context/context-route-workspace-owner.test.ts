import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { resolveWorkspaceRoute } from "./context-route-workspace-owner";

const local = (id: string): ContextTab => ({
  kind: "new",
  documentId: id,
  name: "Untitled",
  resourceHandle: `resource-${id}`,
});
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
  it("uses the exact selected ID among multiple empty tabs", () => {
    const tabs = [local("first"), local("second")];
    expect(
      resolveWorkspaceRoute({
        tabs,
        selectedDocumentId: "first",
        locator: { scheme: "unfiled", path: "", workId: "a" },
      }),
    ).toMatchObject({ kind: "owner", tab: { documentId: "first" } });
  });
  it("allows a project-owned local tab with no Work", () => {
    expect(
      resolveWorkspaceRoute({
        tabs: [local("n")],
        selectedDocumentId: "n",
        locator: { scheme: "unfiled", path: "", workId: null },
      }),
    ).toMatchObject({ kind: "owner", tab: { documentId: "n" } });
  });
  it("returns a redirect fact for the exact materialized local owner", () => {
    expect(
      resolveWorkspaceRoute({
        tabs: [tracked("n", "/Untitled.md", "a", "local-resource")],
        selectedDocumentId: "n",
        locator: { scheme: "unfiled", path: "", workId: "a" },
      }),
    ).toMatchObject({ kind: "materialized-local", target: { path: "/Untitled.md" } });
  });

  it("contextualizes a project-scoped materialized owner with the selected Work", () => {
    const tab: ContextTab = {
      ...tracked("n", "/Opening.md", "a", "local-resource"),
      scheme: "manuscript",
      workId: undefined,
    };
    expect(
      resolveWorkspaceRoute({
        tabs: [tab],
        selectedDocumentId: "n",
        locator: { scheme: "unfiled", path: "", workId: "a" },
      }),
    ).toMatchObject({
      kind: "materialized-local",
      target: { scheme: "manuscript", path: "/Opening.md", workId: "a" },
    });
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
