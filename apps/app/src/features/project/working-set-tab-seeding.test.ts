import { describe, expect, it } from "vitest";
import { contextDeskReconciliation } from "./working-set-tab-seeding";

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
