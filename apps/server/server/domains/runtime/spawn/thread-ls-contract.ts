/** Connected listing follows spawn and cutoff-owner edges, with bounded pages. */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import type { InternalThreadRepositories } from "../../threads/ports/repositories.js";
import { listReadableThreads } from "./thread-ls.js";

export function defineThreadLsContract(
  createHarness: () => Promise<{
    repos: InternalThreadRepositories;
    projectId: ProjectId;
    userId: UserId;
  }>,
) {
  async function fixture() {
    const { repos, projectId, userId } = await createHarness();
    const identity = { projectId, userId };
    const root = await repos.threads.create({ ...identity, title: "root" });
    const cut = await repos.turns.create({
      threadId: root.id,
      role: "user",
      origin: "writer",
      status: "complete",
    });
    async function child(parent = root, title = "child") {
      return repos.threads.createSubagent({
        ...identity,
        parentThreadId: parent.id,
        rootThreadId: root.id,
        originTurnId: cut.id,
        spawnDepth: parent.spawnDepth + 1,
        title,
      });
    }
    async function fork(source = root, originType: "fork" | "handoff" = "fork") {
      return (
        await repos.threads.createDerivedPrimary({
          ...identity,
          id: crypto.randomUUID() as never,
          workId: null,
          source,
          originType,
          originTurnId: cut.id,
          title: "fork",
        })
      ).thread;
    }
    const statusReader = {
      async readMany() {
        return new Map();
      },
    };
    const read = (caller = root, input = {}) =>
      listReadableThreads({ repos, statusReader, caller, input });
    return { repos, root, child, fork, read };
  }
  describe("thread_ls", () => {
    it("allows every lineage edge in both directions, enforces roots and denies live outsiders and trash", async () => {
      const f = await fixture();
      const fork = await f.fork();
      const handoff = await f.fork(f.root, "handoff");
      const child = await f.child();
      const grandchild = await f.child(child);
      const forkChild = await f.child(fork);
      for (const target of [fork, handoff, child, grandchild, forkChild]) {
        expect(target.rootThreadId).toBe(f.root.id);
        expect(typeof (await f.read(f.root, { ref: target.ref }))).toBe("string");
        expect(typeof (await f.read(target, { ref: f.root.ref }))).toBe("string");
      }
      const outsider = await f.repos.threads.create({
        projectId: f.root.projectId,
        userId: f.root.userId,
      });
      expect(await f.read(f.root, { ref: outsider.ref })).toMatchObject({
        ok: false,
        error: { code: "thread_not_connected" },
      });
      await f.repos.threads.setTrashState(child.id, "deleted");
      expect(await f.read(f.root, { ref: child.ref })).toMatchObject({
        ok: false,
        error: { code: "thread_not_found" },
      });
    });
    it("worked example and depth 1 to 3 follow spawn and derivation edges", async () => {
      const f = await fixture();
      const b1 = await f.child(f.root, "b1");
      const b2 = await f.child(f.root, "b2");
      const c1 = await f.child(b1, "c1");
      const deep = await f.child(c1, "deep");
      const fork = await f.fork();
      const one = await f.read();
      expect(one).toContain(fork.ref);
      expect(one).toContain(b2.ref);
      expect(one).toContain(b1.ref);
      expect(one).not.toContain("deep");
      expect(await f.read(f.root, { depth: 2 })).toContain(c1.ref);
      expect(await f.read(f.root, { depth: 3 })).toContain(deep.ref);
      expect(await f.read(c1)).toContain(`${f.root.ref} › spawn ${b1.ref} › spawn ${c1.ref}`);
    });
    it("60 children page newest 50 then the rest", async () => {
      const f = await fixture();
      for (let i = 0; i < 60; i++) await f.child(f.root, `child-${i}`);
      const first = await f.read();
      expect(typeof first).toBe("string");
      const text = first as string;
      expect(text.match(/child-\d+/g)).toHaveLength(50);
      const cursor = JSON.parse(
        (text.split("…older: thread_ls(")[1] as string).slice(0, -1),
      ).cursor;
      const second = await f.read(f.root, { cursor });
      const secondNames = (second as string).match(/child-\d+/g) ?? [];
      expect(secondNames).toHaveLength(10);
      expect(new Set([...(text.match(/child-\d+/g) ?? []), ...secondNames]).size).toBe(60);
    });
    it("keeps a trashed hop in the path and inherited-cut forks under the owner", async () => {
      const f = await fixture();
      const fork = await f.fork();
      const fork2 = await f.fork(fork);
      const child = await f.child(fork, "grandchild");
      await f.repos.threads.setTrashState(fork.id, "deleted");
      expect(await f.read(child)).toContain(`${fork.ref} (in trash)`);
      expect(await f.read()).toContain(fork2.ref);
      expect(await f.read()).not.toContain(`${fork.ref} `);
    });
  });
}
