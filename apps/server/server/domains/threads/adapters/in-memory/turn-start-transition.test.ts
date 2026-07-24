/** Concurrency coverage for the in-memory turn-start transition boundary. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { TurnStartConflictError } from "../../domain/turn-start-transition.js";
import { createInMemoryRepositories } from "./repositories.js";

describe("in-memory turn start transition", () => {
  it("preserves the winner when a concurrent transition loses", async () => {
    const repos = createInMemoryRepositories();
    const thread = await repos.threads.create({
      id: "thread-1" as ThreadId,
      userId: "user-1",
      projectId: "project-1",
    });
    let loserOperationRan = false;

    async function start(userTurnId: TurnId, assistantTurnId: TurnId) {
      return repos.runTurnStartTransition(thread.id as ThreadId, null, async () => {
        await Promise.resolve();
        const userTurn = await repos.turns.create({
          id: userTurnId,
          threadId: thread.id as ThreadId,
          role: "user",
          status: "complete",
        });
        return repos.turns.create({
          id: assistantTurnId,
          threadId: thread.id as ThreadId,
          prevTurnId: userTurn.id,
          role: "assistant",
          status: "streaming",
        });
      });
    }

    const winner = start("user-a" as TurnId, "assistant-a" as TurnId);
    const loser = repos.runTurnStartTransition(thread.id as ThreadId, null, async () => {
      loserOperationRan = true;
      return start("user-b" as TurnId, "assistant-b" as TurnId);
    });
    const results = await Promise.allSettled([winner, loser]);

    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    expect(results[1]).toMatchObject({
      reason: expect.any(TurnStartConflictError),
    });
    expect(loserOperationRan).toBe(false);
    expect(await repos.turns.listByThread(thread.id as ThreadId)).toHaveLength(2);
    expect((await repos.threads.findById(thread.id as ThreadId))?.activeLeafTurnId).toBe(
      "assistant-a",
    );
  });

  it("does not let a rollback on another thread erase a committed transition", async () => {
    const repos = createInMemoryRepositories();
    const firstThread = await repos.threads.create({
      id: "thread-1" as ThreadId,
      userId: "user-1",
      projectId: "project-1",
    });
    const secondThread = await repos.threads.create({
      id: "thread-2" as ThreadId,
      userId: "user-1",
      projectId: "project-1",
    });

    const rolledBack = repos.transaction(async () => {
      await repos.turns.create({
        id: "user-a" as TurnId,
        threadId: firstThread.id as ThreadId,
        role: "user",
        status: "complete",
      });
      await Promise.resolve();
      throw new Error("rollback");
    });
    const committed = repos.runTurnStartTransition(secondThread.id as ThreadId, null, async () => {
      const userTurn = await repos.turns.create({
        id: "user-b" as TurnId,
        threadId: secondThread.id as ThreadId,
        role: "user",
        status: "complete",
      });
      return repos.turns.create({
        id: "assistant-b" as TurnId,
        threadId: secondThread.id as ThreadId,
        prevTurnId: userTurn.id,
        role: "assistant",
        status: "streaming",
      });
    });

    const results = await Promise.allSettled([rolledBack, committed]);

    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("fulfilled");
    expect(await repos.turns.listByThread(firstThread.id as ThreadId)).toHaveLength(0);
    expect(await repos.turns.listByThread(secondThread.id as ThreadId)).toHaveLength(2);
    expect((await repos.threads.findById(secondThread.id as ThreadId))?.activeLeafTurnId).toBe(
      "assistant-b",
    );
  });
});
