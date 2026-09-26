/**
 * Fork history hydration: a fork inherits its SOURCE's history through
 * `originTurnId`. Forks are siblings of their source, so `parentThreadId` is
 * the source's parent and must never be used to find the source.
 */
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  type ForkThreadContextDeps,
  loadThreadConversationContext,
} from "./fork-thread-context.js";

function thread(id: string, extra: Partial<Thread> = {}): Thread {
  return { id, originType: null, originTurnId: null, parentThreadId: null, ...extra } as Thread;
}
function turn(id: string, threadId: string): Turn {
  return { id, threadId } as Turn;
}
function block(id: string, turnId: string): Block {
  return { id, turnId } as Block;
}

function depsFor(threads: Thread[], turns: Turn[], blocks: Block[]): ForkThreadContextDeps {
  return {
    threads: { findById: async (id: string) => threads.find((t) => t.id === id) ?? null },
    turns: {
      listByThread: async (id: string) => turns.filter((t) => t.threadId === id),
      findById: async (id: string) => turns.find((t) => t.id === id) ?? null,
    },
    blocks: {
      listByThread: async (id: string) =>
        blocks.filter((b) => turns.some((t) => t.id === b.turnId && t.threadId === id)),
    },
  } as unknown as ForkThreadContextDeps;
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
});
