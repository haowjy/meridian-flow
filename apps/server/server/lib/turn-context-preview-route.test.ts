import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { handleGetTurnContextPreview } from "./turn-context-preview-route.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000901";
const USER_ID = "00000000-0000-4000-8000-000000000902";

describe("handleGetTurnContextPreview", () => {
  it("returns an error status when a fork's cutoff is missing", async () => {
    const fork = {
      id: THREAD_ID,
      projectId: "project-1",
      userId: USER_ID,
      deletedAt: null,
      originType: "fork",
      originTurnId: "missing-turn",
    } as Thread;

    await expect(
      handleGetTurnContextPreview(
        {
          repos: {
            threads: { findById: async () => fork },
            turns: {
              listByThread: async () => [],
              findById: async () => null,
            },
            blocks: { listByThread: async () => [] },
          } as never,
          projectRepo: {
            findById: async () => ({ id: "project-1", userId: USER_ID, deletedAt: null }),
          } as never,
          modelRequestDebug: { captureEnabled: true } as never,
          agentRevisions: {} as never,
          toolRegistry: {} as never,
          toolExecutor: {} as never,
          workContext: {} as never,
        },
        { threadId: THREAD_ID, userId: USER_ID },
      ),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});
