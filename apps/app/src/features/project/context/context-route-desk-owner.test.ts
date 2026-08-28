import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { resolveDeskRoute } from "./context-route-desk-owner";

const local = (id: string, workId: string): ContextTab => ({
  kind: "new",
  documentId: id,
  name: "Untitled",
  workId,
});
const tracked = (
  id: string,
  path: string,
  workId: string,
  origin?: "local-untitled",
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

describe("resolveDeskRoute", () => {
  it("uses the exact selected ID among multiple empty tabs", () => {
    const tabs = [local("first", "a"), local("second", "a")];
    expect(
      resolveDeskRoute({
        tabs,
        selectedDocumentId: "first",
        locator: { scheme: "scratch", path: "", workId: "a" },
      }),
    ).toMatchObject({ kind: "owner", tab: { documentId: "first" } });
  });
  it("does not grant a wrong-Work local tab authority", () => {
    expect(
      resolveDeskRoute({
        tabs: [local("n", "a")],
        selectedDocumentId: "n",
        locator: { scheme: "scratch", path: "", workId: "b" },
      }),
    ).toEqual({ kind: "unowned" });
  });
  it("returns a redirect fact for the exact materialized local owner", () => {
    expect(
      resolveDeskRoute({
        tabs: [tracked("n", "/Untitled.md", "a", "local-untitled")],
        selectedDocumentId: "n",
        locator: { scheme: "scratch", path: "", workId: "a" },
      }),
    ).toMatchObject({ kind: "materialized-local", target: { path: "/Untitled.md" } });
  });

  it("contextualizes a project-scoped materialized owner with the selected Work", () => {
    const tab: ContextTab = {
      ...tracked("n", "/Opening.md", "a", "local-untitled"),
      scheme: "manuscript",
      workId: undefined,
    };
    expect(
      resolveDeskRoute({
        tabs: [tab],
        selectedDocumentId: "n",
        locator: { scheme: "scratch", path: "", workId: "a" },
      }),
    ).toMatchObject({
      kind: "materialized-local",
      target: { scheme: "manuscript", path: "/Opening.md", workId: "a" },
    });
  });
  it("matches exact server scheme, path, and Work", () => {
    expect(
      resolveDeskRoute({
        tabs: [tracked("a", "/same.md", "a"), tracked("b", "/same.md", "b")],
        selectedDocumentId: "a",
        locator: { scheme: "scratch", path: "/same.md", workId: "b" },
      }),
    ).toMatchObject({ kind: "owner", tab: { documentId: "b" } });
  });
});
