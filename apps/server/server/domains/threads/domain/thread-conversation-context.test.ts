/** Fork history hydration resolves the cutoff owner and refuses incomplete lineage. */
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  loadThreadConversationContext,
  type ThreadConversationContextDeps,
  ThreadConversationContextError,
} from "./thread-conversation-context.js";

function thread(id: string, extra: Partial<Thread> = {}): Thread {
  return { id, originType: null, originTurnId: null, parentThreadId: null, ...extra } as Thread;
}
function turn(id: string, threadId: string): Turn {
  return { id, threadId } as Turn;
}
function block(id: string, turnId: string): Block {
  return { id, turnId } as Block;
}

function depsFor(threads: Thread[], turns: Turn[], blocks: Block[]): ThreadConversationContextDeps {
  return {
    threads: {
      findByIdIncludingDeleted: async (id: string) => threads.find((t) => t.id === id) ?? null,
    },
    turns: {
      listByThread: async (id: string) => turns.filter((t) => t.threadId === id),
      findById: async (id: string) => turns.find((t) => t.id === id) ?? null,
    },
    blocks: {
      listByThread: async (id: string) =>
        blocks.filter((b) => turns.some((t) => t.id === b.turnId && t.threadId === id)),
    },
  } as unknown as ThreadConversationContextDeps;
}

describe("loadThreadConversationContext", () => {
  it("a fork of a root thread inherits the root's history through originTurnId", async () => {
    const root = thread("root");
    const fork = thread("fork", { originType: "fork", originTurnId: "r2", parentThreadId: null });
    const turns = [turn("r1", "root"), turn("r2", "root"), turn("r3", "root"), turn("f1", "fork")];
    const blocks = [block("b1", "r1"), block("b3", "r3"), block("bf", "f1")];

    const context = await loadThreadConversationContext(depsFor([root, fork], turns, blocks), fork);

    expect(context.turns.map((t) => t.id)).toEqual(["r1", "r2", "f1"]);
    expect(context.blocks.map((b) => b.id)).toEqual(["b1", "bf"]);
  });

  it("a sibling fork of a subagent inherits the subagent's history, not the shared parent's", async () => {
    const parent = thread("parent");
    const child = thread("child", { parentThreadId: "parent" });
    const fork = thread("fork", {
      originType: "fork",
      originTurnId: "c1",
      parentThreadId: "parent",
    });
    const turns = [turn("p1", "parent"), turn("c1", "child"), turn("c2", "child")];

    const context = await loadThreadConversationContext(
      depsFor([parent, child, fork], turns, []),
      fork,
    );

    expect(context.turns.map((t) => t.id)).toEqual(["c1"]);
  });

  it("a fork of a fork inherits through both sources", async () => {
    const root = thread("root");
    const fork1 = thread("fork1", { originType: "fork", originTurnId: "r1" });
    const fork2 = thread("fork2", { originType: "fork", originTurnId: "f1" });
    const turns = [
      turn("r1", "root"),
      turn("r2", "root"),
      turn("f1", "fork1"),
      turn("f2", "fork1"),
    ];

    const context = await loadThreadConversationContext(
      depsFor([root, fork1, fork2], turns, []),
      fork2,
    );

    expect(context.turns.map((t) => t.id)).toEqual(["r1", "f1"]);
  });

  it("throws a typed error when the cutoff is missing instead of returning local turns", async () => {
    const fork = thread("fork", { originType: "fork", originTurnId: "missing" });

    await expect(
      loadThreadConversationContext(depsFor([fork], [turn("local", "fork")], []), fork),
    ).rejects.toMatchObject({
      name: "ThreadConversationContextError",
      code: "missing_cutoff_turn",
      threadId: "fork",
    });
  });

  it("throws a typed error when the cutoff owner is missing", async () => {
    const fork = thread("fork", { originType: "fork", originTurnId: "orphaned" });

    const context = loadThreadConversationContext(
      depsFor([fork], [turn("orphaned", "deleted")], []),
      fork,
    );
    await expect(context).rejects.toBeInstanceOf(ThreadConversationContextError);
    await expect(context).rejects.toMatchObject({ code: "missing_cutoff_owner" });
  });

  it("throws a typed error when the cutoff is not in its owner's effective transcript", async () => {
    const owner = thread("owner");
    const fork = thread("fork", { originType: "fork", originTurnId: "after-cutoff" });
    const deps = depsFor([owner, fork], [turn("after-cutoff", "owner")], []);
    deps.turns.listByThread = async () => [];

    await expect(loadThreadConversationContext(deps, fork)).rejects.toMatchObject({
      code: "cutoff_not_in_transcript",
    });
  });

  it("refuses a cycle in fork lineage", async () => {
    const forkA = thread("fork-a", { originType: "fork", originTurnId: "turn-b" });
    const forkB = thread("fork-b", { originType: "fork", originTurnId: "turn-a" });

    await expect(
      loadThreadConversationContext(
        depsFor([forkA, forkB], [turn("turn-a", "fork-a"), turn("turn-b", "fork-b")], []),
        forkA,
      ),
    ).rejects.toMatchObject({ code: "fork_cycle" });
  });
});
