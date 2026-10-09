/** Work validation and filtering for the Project chat-feed domain operation. */
import type { ProjectId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryWorkRepository } from "../../projects/adapters/work-repository/in-memory.js";
import { createInMemoryRepositories } from "../adapters/in-memory/repositories.js";
import { getProjectChatFeedPage, ProjectChatFeedWorkUnavailableError } from "./chat-feed.js";

describe("getProjectChatFeedPage", () => {
  it("rejects a Work owned by another project", async () => {
    const works = createInMemoryWorkRepository();
    const foreignWork = await works.create({
      projectId: "another-project" as ProjectId,
      name: "Elsewhere",
    });
    const repos = createInMemoryRepositories({ works });

    await expect(
      getProjectChatFeedPage({
        repository: repos.chatFeed,
        works,
        projectId: "project",
        userId: "user",
        workId: foreignWork.id,
      }),
    ).rejects.toBeInstanceOf(ProjectChatFeedWorkUnavailableError);
  });

  it("rejects a soft-deleted Work", async () => {
    const works = createInMemoryWorkRepository();
    const work = await works.create({ projectId: "project" as ProjectId, name: "Deleted" });
    await works.softDelete(work.id);
    const repos = createInMemoryRepositories({ works });

    await expect(
      getProjectChatFeedPage({
        repository: repos.chatFeed,
        works,
        projectId: "project",
        userId: "user",
        workId: work.id,
      }),
    ).rejects.toBeInstanceOf(ProjectChatFeedWorkUnavailableError);
  });
});
