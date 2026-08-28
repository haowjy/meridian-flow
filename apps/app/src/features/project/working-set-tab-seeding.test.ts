import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import {
  contextDeskReconciliation,
  mergeBootstrapDeskTabs,
  settleSeededRoutes,
} from "./working-set-tab-seeding";

describe("Context desk bootstrap source", () => {
  it("replaces from authoritative server hydration and preserves degraded local state", () => {
    expect(
      contextDeskReconciliation({
        status: "server",
        row: {
          userId: "user-1",
          projectId: "project-1",
          revision: 1,
          recentRoutes: [],
          lastThreadId: null,
          updatedAt: new Date(0).toISOString(),
        },
      }),
    ).toBe("server-replace");
    expect(contextDeskReconciliation({ status: "read-degraded" })).toBe("local-keep");
  });
});

describe("server hydration route settlement", () => {
  const restored: ContextTab = {
    kind: "tracked",
    documentId: "a",
    scheme: "manuscript",
    path: "/a.md",
    name: "a.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };

  it("preserves the restored row on rejection", () => {
    expect(
      settleSeededRoutes(
        [{ scheme: "manuscript", path: "/a.md" }],
        [restored],
        [{ status: "rejected", reason: new Error("offline") }],
      ),
    ).toEqual([{ tab: restored, removedRoute: null }]);
  });

  it("drops only a positively missing row and accepts refreshed metadata", () => {
    const refreshed = { ...restored, name: "renamed.md" };
    expect(
      settleSeededRoutes(
        [
          { scheme: "manuscript", path: "/a.md" },
          { scheme: "kb", path: "/missing.md" },
        ],
        [restored],
        [
          { status: "fulfilled", value: { tab: refreshed, removedRoute: null } },
          {
            status: "fulfilled",
            value: {
              tab: null,
              removedRoute: { scheme: "kb", path: "/missing.md" },
            },
          },
        ],
      ),
    ).toEqual([
      { tab: refreshed, removedRoute: null },
      { tab: null, removedRoute: { scheme: "kb", path: "/missing.md" } },
    ]);
  });
});

describe("device-local bootstrap ownership", () => {
  it("merges empty tabs without turning them into server recency", () => {
    const chapter: ContextTab = {
      kind: "tracked",
      documentId: "chapter",
      scheme: "manuscript",
      path: "/chapter.md",
      name: "chapter.md",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    };
    const local: ContextTab = {
      kind: "new",
      documentId: "local",
      name: "Untitled",
      workId: "work-a",
    };
    expect(mergeBootstrapDeskTabs([chapter], [local])).toEqual([chapter, local]);
  });

  it("preserves local origin while accepting refreshed server metadata by exact ID", () => {
    const refreshed: ContextTab = {
      kind: "tracked",
      documentId: "local",
      scheme: "scratch",
      path: "/Renamed.md",
      name: "Renamed.md",
      workId: "work-a",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
      provisionalName: false,
    };
    const local: ContextTab = {
      ...refreshed,
      path: "/Untitled.md",
      name: "Untitled.md",
      origin: "local-untitled",
    };
    expect(mergeBootstrapDeskTabs([refreshed], [local])).toEqual([
      { ...refreshed, origin: "local-untitled" },
    ]);
  });
});
