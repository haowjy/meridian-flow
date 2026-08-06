/** Durable Work receipt inverse execution through the reversal boundary. */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryWorkRepository, deleteWork } from "../domains/projects/index.js";
import { reverseWorkReceipts } from "./work-receipt-reversal.js";

describe("Work receipt reversal", () => {
  it("restores a deleted Work from its durable tool-result receipt", async () => {
    const works = createInMemoryWorkRepository();
    const work = await works.create({
      projectId: "project-1",
      createdByUserId: "user-1",
      name: "Revision",
    });
    const projectChanged = vi.fn(async () => {});
    await deleteWork({ works, contextUpdates: { projectChanged } }, work.id);
    projectChanged.mockClear();

    await expect(
      reverseWorkReceipts(
        {
          works,
          contextUpdates: { projectChanged },
          turns: {
            findById: async () => ({ id: "turn-1", threadId: "thread-1" }) as never,
          },
          blocks: {
            listByTurn: async () => [
              {
                content: {
                  toolCallId: "call-work",
                  output: { slug: "revision" },
                  metadata: {
                    workReceipt: {
                      category: "mutate",
                      line: "Deleted Work Revision.",
                      inverse: { command: "restore", workId: work.id },
                    },
                  },
                },
              } as never,
            ],
          },
        },
        { threadId: "thread-1", turnId: "turn-1", direction: "undo" },
      ),
    ).resolves.toEqual([{ command: "restore", workId: work.id, status: "restored" }]);
    await expect(works.findById(work.id)).resolves.toMatchObject({ deletedAt: null });
    expect(projectChanged).toHaveBeenCalledWith("project-1");
  });

  it("does not execute receipts from a turn owned by another thread", async () => {
    const works = createInMemoryWorkRepository();
    const listByTurn = vi.fn(async () => []);
    await expect(
      reverseWorkReceipts(
        {
          works,
          contextUpdates: { projectChanged: async () => {} },
          turns: {
            findById: async () => ({ id: "turn-1", threadId: "thread-2" }) as never,
          },
          blocks: { listByTurn },
        },
        { threadId: "thread-1", turnId: "turn-1", direction: "undo" },
      ),
    ).resolves.toEqual([]);
    expect(listByTurn).not.toHaveBeenCalled();
  });
});
