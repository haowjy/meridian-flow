/** Scope overlap coalesces only pending repairs; disjoint scopes retain concurrency. */
import type { CatalogScope } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { createCatalogRepairQueue } from "./catalog-repair-queue.js";

const scope = (projectId: string): CatalogScope => ({ kind: "project", projectId });
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("catalog repair queue", () => {
  it("waits for both active scopes before running a coalesced bridging group", async () => {
    const runs: string[][] = [];
    const releases: Array<() => void> = [];
    const queue = createCatalogRepairQueue(async (requests) => {
      runs.push(requests.flatMap((request) => request.sourceIds).sort());
      await new Promise<void>((resolve) => releases.push(resolve));
    });
    const enqueue = (id: string, projects: string[]) =>
      queue.enqueue({
        scopes: projects.map(scope),
        sourceIds: [id],
        invalidatedRootIds: [],
        projectIds: projects,
        userIds: [],
        availabilityGeneration: "1",
      });
    const a = enqueue("a", ["a"]);
    const b = enqueue("b", ["b"]);
    await nextTurn();
    expect(runs).toEqual([["a"], ["b"]]);
    const ab = enqueue("ab", ["a", "b"]);
    const bc = enqueue("bc", ["b", "c"]);
    const c = enqueue("c", ["c"]);
    releases[0]();
    await a;
    await nextTurn();
    expect(runs).toHaveLength(2);
    releases[1]();
    await b;
    await nextTurn();
    expect(runs).toEqual([["a"], ["b"], ["ab", "bc", "c"]]);
    releases[2]();
    await Promise.all([ab, bc, c]);
  });

  it("releases failed scopes and runs the dirty batch rather than dropping it", async () => {
    let rejectFirst: (cause: unknown) => void = () => {};
    let calls = 0;
    const queue = createCatalogRepairQueue(async () => {
      if (++calls === 1)
        await new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
    });
    const request = {
      scopes: [scope("a")],
      sourceIds: [],
      invalidatedRootIds: [],
      projectIds: ["a"],
      userIds: [],
      availabilityGeneration: "1",
    };
    const first = queue.enqueue(request);
    const failure = expect(first).rejects.toThrow("offline");
    await nextTurn();
    const second = queue.enqueue(request);
    rejectFirst(new Error("offline"));
    await failure;
    await second;
    expect(calls).toBe(2);
  });
});
