import { describe, expect, it } from "vitest";

import { contextDeskReconciliation, isWorkingSetRouteDesired } from "./working-set-tab-seeding";

describe("working-set tab seeding desired-state guard", () => {
  it("matches the full work-scoped route identity", () => {
    const route = { scheme: "scratch" as const, path: "/draft.md", workId: "work-1" };
    expect(isWorkingSetRouteDesired(route, [route])).toBe(true);
    expect(isWorkingSetRouteDesired(route, [{ ...route, workId: "work-2" }])).toBe(false);
    expect(isWorkingSetRouteDesired(route, [])).toBe(false);
  });
});

describe("context desk hydration reconciliation", () => {
  it("replaces only for server adoption", () => {
    expect(
      contextDeskReconciliation({
        status: "server",
        row: {
          userId: "user-1",
          projectId: "project-1",
          revision: 2,
          recentRoutes: [],
          lastThreadId: null,
          updatedAt: "2026-07-17T00:00:00.000Z",
        },
      }),
    ).toBe("server-replace");
    expect(contextDeskReconciliation({ status: "local", revision: 2 })).toBe("local-keep");
    expect(contextDeskReconciliation({ status: "disabled" })).toBe("local-keep");
    expect(contextDeskReconciliation({ status: "read-degraded" })).toBe("local-keep");
  });
});
