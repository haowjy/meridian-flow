/** Behavioral parity for transactional execution-report persistence. */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "./repositories.js";

describe("in-memory execution reports", () => {
  it("rolls back every phase, isolates returned data, and keeps retries immutable", async () => {
    const repos = createInMemoryRepositories();
    const userId = crypto.randomUUID() as UserId;
    const projectId = crypto.randomUUID() as ProjectId;
    const root = await repos.threads.create({ userId, projectId });
    const callerTurn = await repos.turns.create({ threadId: root.id, role: "assistant" });
    const child = await repos.threads.createSubagent({
      userId,
      projectId,
      parentThreadId: root.id,
      rootThreadId: root.id,
      spawnDepth: 1,
      originTurnId: callerTurn.id,
    });
    const turn = await repos.turns.create({ threadId: child.id, role: "assistant" });
    const input = {
      childThreadId: child.id,
      assistantTurnId: turn.id,
      handle: child.ref ?? "",
      origin: "spawn" as const,
      deliveryMode: "background_notification" as const,
      callerThreadId: root.id,
      callerTurnId: callerTurn.id,
      toolCallId: "call",
      cardBlockId: null,
    };
    await expect(
      repos.transaction(async () => {
        await repos.executionReports.admit(input);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await repos.executionReports.findByExecution(child.id, turn.id)).toBeNull();
    await repos.executionReports.admit(input);
    const payload = '{"nested":[1,true,null,"text"]}';
    await expect(
      repos.transaction(async () => {
        await repos.executionReports.captureOnce(child.id, turn.id, "return", {
          summary: "saved",
          payload,
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await repos.executionReports.findByExecution(child.id, turn.id))?.capture).toBeNull();
    await repos.executionReports.captureOnce(child.id, turn.id, "return", {
      summary: "saved",
      payload,
    });
    const terminal = {
      childThreadId: child.id,
      assistantTurnId: turn.id,
      outcome: "succeeded" as const,
      reason: null,
      source: "return_result" as const,
      summary: "saved",
      payload,
    };
    await expect(
      repos.transaction(async () => {
        await repos.executionReports.finalizeOnce(terminal);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await repos.executionReports.findByExecution(child.id, turn.id))?.outcome).toBeNull();
    const saved = await repos.executionReports.finalizeOnce(terminal);
    expect(saved.publication).toBe("pending");
    expect(saved.payload).toBe(payload);
    saved.summary = "external mutation";
    expect((await repos.executionReports.findByExecution(child.id, turn.id))?.summary).toBe(
      "saved",
    );
    expect((await repos.executionReports.admit(input)).summary).toBe("saved");
    expect(
      (
        await repos.executionReports.captureOnce(child.id, turn.id, "return", {
          summary: "saved",
          payload,
        })
      ).summary,
    ).toBe("saved");
    await expect(
      repos.executionReports.captureOnce(child.id, turn.id, "different", { summary: "saved" }),
    ).rejects.toThrow();
    await expect(
      repos.transaction(async () => {
        await repos.executionReports.markPublished(child.id, turn.id, "published");
        throw new Error("rollback publication");
      }),
    ).rejects.toThrow("rollback publication");
    expect((await repos.executionReports.findByExecution(child.id, turn.id))?.publication).toBe(
      "pending",
    );
    await repos.executionReports.markPublished(child.id, turn.id, "published");
    expect(await repos.executionReports.finalizeOnce(terminal)).toMatchObject({
      publication: "published",
      summary: "saved",
    });
    await expect(
      repos.executionReports.finalizeOnce({
        ...terminal,
        payload: { nested: [1, true, null, "text"] },
      }),
    ).rejects.toThrow();
    const other = await repos.threads.createSubagent({
      userId,
      projectId,
      parentThreadId: root.id,
      rootThreadId: root.id,
      spawnDepth: 1,
    });
    await expect(
      repos.executionReports.admit({ ...input, childThreadId: other.id, handle: other.ref ?? "" }),
    ).rejects.toThrow();
  });
});
