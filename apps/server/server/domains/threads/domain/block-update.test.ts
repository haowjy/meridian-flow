/** A block.updated fact replaces an existing card but never creates or relocates one. */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "../adapters/in-memory/repositories.js";
import { projectReadModelEvent } from "./read-model-projector.js";

describe("block.updated", () => {
  it("preserves card placement and rejects a missing target", async () => {
    const repos = createInMemoryRepositories();
    const thread = await repos.threads.create({
      userId: crypto.randomUUID() as UserId,
      projectId: crypto.randomUUID() as ProjectId,
    });
    const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });
    const card = await repos.blocks.create({
      turnId: turn.id,
      blockType: "custom",
      sequence: 3,
      content: { status: "running" },
    });
    const block = {
      id: card.id,
      turnId: turn.id,
      sequence: 3,
      blockType: "custom" as const,
      content: { status: "completed" },
      status: "complete" as const,
    };
    await projectReadModelEvent(repos, { type: "block.updated", block });
    expect(await repos.blocks.findById(card.id)).toMatchObject({
      id: card.id,
      turnId: turn.id,
      sequence: 3,
      content: { status: "completed" },
    });
    await expect(
      projectReadModelEvent(repos, {
        type: "block.updated",
        block: { ...block, id: crypto.randomUUID() },
      }),
    ).rejects.toThrow("Cannot replace missing block");
    expect(await repos.blocks.listByTurn(turn.id)).toHaveLength(1);
  });
});
