/** Connected listing follows spawn and cutoff-owner edges, with bounded pages. */
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
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
    const awakeThreadIds = new Set<ThreadId>();
    const statusReader = {
      async readMany(threadIds: readonly ThreadId[]) {
        return new Map(
          threadIds
            .filter((threadId) => awakeThreadIds.has(threadId))
            .map((threadId) => [threadId, undefined as never]),
        );
      },
    };
    const read = (caller = root, input = {}) =>
      listReadableThreads({ repos, statusReader, caller, input }).then((result) =>
        "listing" in result ? result.listing : result,
      );
    async function requester(
      thread: Awaited<ReturnType<typeof child>> | typeof root,
      text: string,
      options: { origin?: "writer" | "system"; metadata?: Record<string, string> } = {},
    ) {
      const previous = await repos.turns.getLatestByThread(thread.id as ThreadId);
      const turn = await repos.turns.create({
        threadId: thread.id,
        prevTurnId: previous?.id ?? null,
        role: "user",
        origin: options.origin ?? "writer",
        status: "complete",
        metadata: options.metadata ?? null,
      });
      await repos.blocks.create({
        turnId: turn.id,
        blockType: "text",
        sequence: 0,
        textContent: text,
      });
      return turn;
    }
    const setAwake = (thread: { id: string }) => awakeThreadIds.add(thread.id as ThreadId);
    return { repos, root, child, fork, requester, read, setAwake };
  }
  describe("thread_ls", () => {
    it("allows every lineage edge in both directions, enforces roots and denies live outsiders and trash", async () => {
      const f = await fixture();
      const fork = await f.fork();
      const handoff = await f.fork(f.root, "handoff");
      const child = await f.child();
      const grandchild = await f.child(child);
      const forkChild = await f.child(fork);
      for (const target of [fork, child, grandchild, forkChild]) {
        expect(target.rootThreadId).toBe(f.root.id);
        expect(typeof (await f.read(f.root, { ref: target.ref }))).toBe("string");
        expect(typeof (await f.read(target, { ref: f.root.ref }))).toBe("string");
      }
      expect(handoff.rootThreadId).toBe(handoff.id);
      // Explicit navigation admits the direct source connection; descendant listings stay lineage-scoped.
      expect(typeof (await f.read(f.root, { ref: handoff.ref }))).toBe("string");
      expect(typeof (await f.read(handoff, { ref: f.root.ref }))).toBe("string");
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
