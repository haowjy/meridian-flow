/** Connected listing follows spawn and cutoff-owner edges, with bounded pages. */
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import type { InternalThreadRepositories } from "../../threads/ports/repositories.js";
import { formatLastAsked, listReadableThreads } from "./thread-ls.js";

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
    it("formats collapsed, quoted snippets at a word boundary", () => {
      expect(formatLastAsked('  Ask   about "the jade token".\nThen verify the gate.  ')).toBe(
        '"Ask about \\"the jade token\\". Then verify the gate."',
      );
      expect(formatLastAsked(`Read ${"continuity ".repeat(15)}notes`)).toBe(
        '"Read continuity continuity continuity continuity continuity continuity continuity continuity…"',
      );
    });

    it("renders the latest local requester turn, skips non-request rows, and omits empty rows", async () => {
      const f = await fixture();
      const child = await f.child(f.root, "Chapter 2 continuity check");
      await f.requester(f.root, "Make the gate guardian suspicious of his jade token.");
      const childRequest = await f.requester(
        child,
        "Read the referenced planning conversation and identify the three continuity risks.",
        {
          origin: "system",
          metadata: { kind: "inbox_message", agentRequestKind: "child_seed" },
        },
      );
      await f.repos.blocks.create({
        turnId: childRequest.id,
        blockType: "custom",
        sequence: 1,
        content: { kind: "thread-reference", text: "ignore inherited reference text" },
      });
      const assistant = await f.repos.turns.create({
        threadId: child.id,
        prevTurnId: (await f.repos.turns.getLatestByThread(child.id))?.id,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await f.repos.blocks.create({
        turnId: assistant.id,
        blockType: "tool_result",
        sequence: 0,
        content: { output: "ignore me" },
      });
      const notice = await f.repos.turns.create({
        threadId: child.id,
        prevTurnId: assistant.id,
        role: "system",
        origin: "system",
        status: "complete",
        metadata: { kind: "system_update", section: "notices" },
      });
      await f.repos.blocks.create({
        turnId: notice.id,
        blockType: "text",
        sequence: 0,
        textContent: "ignore this notice",
      });
      const emptyFork = await f.fork();

      expect(await f.read(f.root, { ref: child.ref })).toMatchInlineSnapshot(`
        "c1 (you) › p2
        p2  Chapter 2 continuity check
             last asked: "Read the referenced planning conversation and identify the three continuity risks.""
      `);
      expect(emptyFork.ref).toBe("c3");
      const rootOutput = await f.read();
      expect(rootOutput).toContain(
        'last asked: "Make the gate guardian suspicious of his jade token."',
      );
      expect(rootOutput).toContain("c3  fork  fork");
      expect(rootOutput).not.toContain("c3  fork  fork\n       last asked:");
    });

    it("uses one batched requester read and lets a parent message replace the spawn prompt", async () => {
      const f = await fixture();
      const child = await f.child(f.root, "continuity");
      await f.requester(child, "Initial spawn prompt", {
        origin: "system",
        metadata: { kind: "inbox_message", agentRequestKind: "child_seed" },
      });
      await f.requester(child, "Check the revised ending instead.", {
        origin: "system",
        metadata: { kind: "inbox_message" },
      });
      let reads = 0;
      const original = f.repos.turns.listLatestLocalRequesterText.bind(f.repos.turns);
      f.repos.turns.listLatestLocalRequesterText = async (threadIds) => {
        reads += 1;
        return original(threadIds);
      };

      const output = await f.read();
      expect(reads).toBe(1);
      expect(output).toContain('last asked: "Check the revised ending instead."');
      expect(output).not.toContain("Initial spawn prompt");
    });

    it("shows a running lifecycle only while the conversation is awake", async () => {
      const f = await fixture();
      const child = await f.child();
      expect(await f.read(f.root, { ref: child.ref })).not.toContain("running");
      f.setAwake(child);
      expect(await f.read(f.root, { ref: child.ref })).toContain("p2  awake  running  child");
    });

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
      expect(await f.read(f.root, { ref: handoff.ref })).toMatchObject({
        ok: false,
        error: { code: "thread_not_connected" },
      });
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
      expect(await f.read(c1)).toContain(`${f.root.ref} › ${b1.ref} › ${c1.ref} (you)`);
    });
    it("identifies the caller when it is outside the rendered path and rows", async () => {
      const f = await fixture();
      const child = await f.child();
      const fork = await f.fork();
      const output = await f.read(fork, { ref: child.ref });
      expect(output).toContain(`${f.root.ref} › ${child.ref} (you are ${fork.ref})`);
      expect(output).not.toContain(`${fork.ref} (you)`);
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
    it("keeps the requested depth on the same-ref continuation", async () => {
      const f = await fixture();
      for (let i = 0; i < 51; i++) await f.child(f.root, `child-${i}`);
      const text = (await f.read(f.root, { depth: 2 })) as string;
      const call = JSON.parse((text.split("…older: thread_ls(")[1] as string).slice(0, -1));
      expect(call).toEqual({ ref: f.root.ref, depth: 2, cursor: expect.any(String) });
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
