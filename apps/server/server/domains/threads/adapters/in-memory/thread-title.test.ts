/** In-memory ThreadRepository persistence contract for the rename command. */
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryRepositories } from "./repositories.js";

const USER_ID = "00000000-0000-4000-8000-000000000201" as UserId;
const PROJECT_ID = "00000000-0000-4000-8000-000000000202" as ProjectId;

async function createThread() {
  const repos = createInMemoryRepositories();
  const thread = await repos.threads.create({ userId: USER_ID, projectId: PROJECT_ID });
  return { repos, threadId: thread.id as ThreadId };
}

describe("ThreadRepository.updateTitle", () => {
  it("persists the title and refreshes updatedAt", async () => {
    const { repos, threadId } = await createThread();
    const before = (await repos.threads.findById(threadId))?.updatedAt ?? "";

    const updated = await repos.threads.updateTitle(threadId, "Renamed chat");

    expect(updated.title).toBe("Renamed chat");
    expect(updated.updatedAt >= before).toBe(true);
    await expect(repos.threads.findById(threadId)).resolves.toMatchObject({
      title: "Renamed chat",
    });
  });

  it("rejects an unknown thread", async () => {
    const repos = createInMemoryRepositories();
    await expect(
      repos.threads.updateTitle("00000000-0000-4000-8000-000000000203" as ThreadId, "Renamed chat"),
    ).rejects.toThrow("Thread not found");
  });
});
