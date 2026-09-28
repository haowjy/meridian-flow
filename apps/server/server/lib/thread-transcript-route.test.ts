/** Writer authorization and inherited-transcript contract for the HTTP adapter. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "../domains/threads/adapters/in-memory/index.js";
import { handleReadThreadTranscript } from "./thread-transcript-route.js";

const USER_ID = "writer" as never;
const PROJECT_ID = "project" as never;

describe("handleReadThreadTranscript", () => {
  it("404s another owner and serves whole inherited turns from a trashed source", async () => {
    const repos = createInMemoryRepositories();
    const source = await repos.threads.create({
      id: "00000000-0000-4000-8000-0000000006c1" as ThreadId,
      projectId: PROJECT_ID,
      userId: USER_ID,
      title: "Source transcript",
    });
    const cutoff = await repos.turns.create({
      id: "source-turn" as TurnId,
      threadId: source.id as ThreadId,
      role: "user",
      origin: "writer",
      status: "complete",
    });
    await repos.blocks.create({
      id: "source-block",
      turnId: cutoff.id as TurnId,
      blockType: "reasoning",
      sequence: 0,
      content: { text: "hidden provider detail", providerOptions: { private: true } },
    });
    const local = await repos.threads.createDerivedPrimary({
      id: "00000000-0000-4000-8000-0000000006c2" as ThreadId,
      userId: USER_ID,
      projectId: PROJECT_ID,
      workId: null,
      source,
      originType: "fork",
      originTurnId: cutoff.id as TurnId,
    });
    await repos.turns.create({
      id: "fork-local" as TurnId,
      threadId: local.thread.id as ThreadId,
      prevTurnId: cutoff.id as TurnId,
      role: "assistant",
      origin: "assistant",
      status: "complete",
    });
    await repos.threads.setTrashState(source.id as ThreadId, "deleted");
    const routeDeps = {
      repos,
      threads: repos.threads,
      projects: {
        async findById(id: string) {
          return { id, userId: USER_ID, deletedAt: null } as never;
        },
      },
    };

    await expect(
      handleReadThreadTranscript(routeDeps, {
        threadId: local.thread.id,
        userId: "another-writer" as never,
        query: { range: "inherited", unit: "turn", order: "oldest_first" },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const response = await handleReadThreadTranscript(routeDeps, {
      threadId: local.thread.id,
      userId: USER_ID,
      query: { range: "inherited", unit: "turn", order: "oldest_first" },
    });
    expect(response.entries.map((entry) => entry.turn.id)).toEqual([cutoff.id]);
    expect(response.entries[0]?.blocks).toEqual([
      expect.objectContaining({
        id: "source-block",
        content: { text: "hidden provider detail" },
      }),
    ]);
    expect(response.owners).toEqual([
      expect.objectContaining({ threadId: source.id, trashed: true }),
    ]);
  });
});
