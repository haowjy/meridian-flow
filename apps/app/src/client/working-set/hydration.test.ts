import type { ProjectWorkingSet } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";

import {
  planSuspectBaselineConfirmation,
  planWorkingSetHydration,
  reduceWorkingSetHydration,
} from "./hydration";

const row: ProjectWorkingSet = {
  userId: "user-1",
  projectId: "project-1",
  recentRoutes: [{ scheme: "kb", path: "/server.md" }],
  lastThreadId: "thread-server",
  revision: 4,
  updatedAt: "2026-07-17T00:00:00.000Z",
};

describe("working-set hydration precedence", () => {
  it("stays read-degraded when the loader read is unavailable", () => {
    expect(reduceWorkingSetHydration({ status: "unavailable" }, undefined)).toEqual({
      status: "read-degraded",
    });
  });

  it("keeps local state when no server row exists", () => {
    expect(reduceWorkingSetHydration({ status: "absent" }, undefined)).toEqual({
      status: "local",
      revision: null,
    });
  });

  it("keeps causally newer local state when its base matches the row", () => {
    const local = {
      snapshot: { recentRoutes: [], lastThreadId: "thread-local" },
      pending: { baseRevision: 4, localVersion: 2 },
    };
    expect(reduceWorkingSetHydration({ status: "row", row }, local)).toEqual({
      status: "local",
      revision: 4,
    });
  });

  it("adopts the server for a row without matching pending lineage", () => {
    const local = {
      snapshot: { recentRoutes: [], lastThreadId: "thread-local" },
      pending: { baseRevision: 3, localVersion: 2 },
    };
    expect(reduceWorkingSetHydration({ status: "row", row }, local)).toEqual({
      status: "server",
      row,
    });
    expect(reduceWorkingSetHydration({ status: "row", row }, undefined)).toEqual({
      status: "server",
      row,
    });
  });

  it("short-circuits outside the reducer when the account toggle is off", () => {
    expect(planWorkingSetHydration(false, { status: "row", row }, undefined)).toEqual({
      status: "disabled",
    });
  });
});

describe("suspect baseline confirmation", () => {
  it("stays read-degraded when the fresh GET is unavailable", () => {
    expect(planSuspectBaselineConfirmation({ status: "unavailable" }, undefined)).toEqual({
      status: "read-degraded",
    });
  });

  it("confirms a matching local lineage without adoption", () => {
    const local = {
      snapshot: { recentRoutes: [], lastThreadId: "thread-local" },
      pending: { baseRevision: 4, localVersion: 2 },
    };
    expect(planSuspectBaselineConfirmation({ status: "row", row }, local)).toEqual({
      status: "confirmed",
      revision: 4,
    });
  });

  it("adopts server data when the row moved past pending lineage", () => {
    const local = {
      snapshot: { recentRoutes: [], lastThreadId: "thread-local" },
      pending: { baseRevision: 3, localVersion: 2 },
    };
    expect(planSuspectBaselineConfirmation({ status: "row", row }, local)).toEqual({
      status: "confirmed",
      revision: 4,
      adopt: {
        recentRoutes: [{ scheme: "kb", path: "/server.md" }],
        lastThreadId: "thread-server",
      },
    });
  });
});
