import type { WorksSnapshot } from "@meridian/contracts/works";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "./project-query-keys";
import {
  acquireWorksSnapshot,
  refreshWorksSnapshot,
  seedWorksSnapshot,
} from "./works-projection-acquisition";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function snapshot(
  revision: string,
  name = `Work ${revision}`,
  requestId = `request-${revision}`,
): WorksSnapshot {
  return {
    projectId: "project-1" as never,
    catalogGeneration: "generation-1",
    authorityRevision: revision,
    requestId,
    works: [
      {
        id: "work-1",
        projectId: "project-1",
        createdByUserId: "user-1",
        name,
        slug: "work-1" as never,
        goal: null,
        description: null,
        status: "active",
        archivedAt: null,
        aiWriteMode: "direct",
        entityRevision: revision,
        unpushedChangeCount: 0,
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
        lastActivityAt: "2026-08-29T00:00:00.000Z",
        deletedAt: null,
      },
    ],
  };
}

function workAt(revision: string) {
  const work = snapshot(revision).works[0];
  if (!work) throw new Error("snapshot fixture must contain one Work");
  return work;
}

describe("Works projection acquisition", () => {
  it("installs only newer revisions and treats an equal seed as hydration-only", () => {
    const client = new QueryClient();
    const key = projectQueryKeys.works("project-1");
    seedWorksSnapshot(client, snapshot("2", "new"));
    seedWorksSnapshot(client, snapshot("1", "old"));
    seedWorksSnapshot(client, snapshot("2", "equal loader"));
    seedWorksSnapshot(client, snapshot("3", "newest"));
    expect(client.getQueryData<WorksSnapshot>(key)?.works[0]?.name).toBe("newest");
  });

  it("coalesces ordinary acquisition ownership", async () => {
    const client = new QueryClient();
    const pending = deferred<WorksSnapshot>();
    const request = vi.fn(() => pending.promise);
    const first = acquireWorksSnapshot(client, "project-1", request);
    const second = acquireWorksSnapshot(client, "project-1", request);
    expect(request).toHaveBeenCalledOnce();
    pending.resolve(snapshot("1"));
    await expect(Promise.all([first, second])).resolves.toEqual([snapshot("1"), snapshot("1")]);
  });

  it("prevents a blocked loader/request from overwriting a newer refresh", async () => {
    const client = new QueryClient();
    const older = deferred<WorksSnapshot>();
    const newer = deferred<WorksSnapshot>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const initial = acquireWorksSnapshot(client, "project-1", request);
    const mutationRefresh = refreshWorksSnapshot(client, "project-1", request);
    newer.resolve(snapshot("2", "restored"));
    await mutationRefresh;
    older.resolve(snapshot("1", "deleted stale response"));
    await initial;

    expect(
      client.getQueryData<WorksSnapshot>(projectQueryKeys.works("project-1"))?.works[0]?.name,
    ).toBe("restored");
  });

  it("prevents a late list response from overwriting a newer loader seed", async () => {
    const client = new QueryClient();
    const pending = deferred<WorksSnapshot>();
    const request = acquireWorksSnapshot(client, "project-1", () => pending.promise);
    seedWorksSnapshot(client, snapshot("3", "newer loader"));
    pending.resolve(snapshot("2", "late list"));
    await request;
    expect(
      client.getQueryData<WorksSnapshot>(projectQueryKeys.works("project-1"))?.works[0]?.name,
    ).toBe("newer loader");
  });

  it("lets the newer-started response win when authority revisions are equal", async () => {
    const client = new QueryClient();
    const older = deferred<WorksSnapshot>();
    const newer = deferred<WorksSnapshot>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const first = acquireWorksSnapshot(client, "project-1", request);
    const second = refreshWorksSnapshot(client, "project-1", request);
    newer.resolve(snapshot("2", "newer-started", "newer"));
    await second;
    older.resolve(snapshot("2", "older-started", "older"));
    await first;
    expect(
      client.getQueryData<WorksSnapshot>(projectQueryKeys.works("project-1"))?.works[0]?.name,
    ).toBe("newer-started");
  });

  it("converges archive/unarchive and delete/restore snapshots atomically without resurrection", async () => {
    const client = new QueryClient();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ...snapshot("1", "active"),
        works: [{ ...workAt("1"), status: "active" }],
      })
      .mockResolvedValueOnce({
        ...snapshot("2", "archived"),
        works: [{ ...workAt("2"), status: "archived" }],
      })
      .mockResolvedValueOnce({
        ...snapshot("3", "unarchived"),
        works: [{ ...workAt("3"), status: "active" }],
      })
      .mockResolvedValueOnce({
        ...snapshot("4", "deleted"),
        works: [{ ...workAt("4"), deletedAt: "2026-08-29T01:00:00.000Z" }],
      })
      .mockResolvedValueOnce({
        ...snapshot("5", "restored"),
        works: [{ ...workAt("5"), name: "restored", deletedAt: null }],
      });
    for (let index = 0; index < 5; index += 1) {
      await refreshWorksSnapshot(client, "project-1", request);
    }
    seedWorksSnapshot(client, snapshot("4", "stale resurrection"));
    expect(client.getQueryData<WorksSnapshot>(projectQueryKeys.works("project-1"))).toMatchObject({
      authorityRevision: "5",
      works: [{ name: "restored", deletedAt: null }],
    });
  });

  it("represents zero Works without selecting or resurrecting a fallback", async () => {
    const client = new QueryClient();
    const empty = { ...snapshot("0"), works: [] };
    await acquireWorksSnapshot(
      client,
      "project-1",
      vi.fn(async () => empty),
    );
    expect(client.getQueryData<WorksSnapshot>(projectQueryKeys.works("project-1"))).toEqual(empty);
  });
});
