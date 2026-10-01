/** Work validation and filtering for the Project chat-feed domain operation. */
import type { ProjectId, ThreadId, UserId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryWorkRepository } from "../../projects/adapters/work-repository/in-memory.js";
import { createInMemoryRepositories } from "../adapters/in-memory/repositories.js";
import { getProjectChatFeedPage, ProjectChatFeedWorkUnavailableError } from "./chat-feed.js";

describe("getProjectChatFeedPage", () => {
  it("filters by Work before search and favorite filters", async () => {
    const works = createInMemoryWorkRepository();
    const work = await works.create({ projectId: "project" as ProjectId, name: "The sect" });
    const otherWork = await works.create({ projectId: "project" as ProjectId, name: "Other" });
    const repos = createInMemoryRepositories({ works });
    const matchingFavorite = await repos.threads.create({
      projectId: "project",
      userId: "user",
      title: "Sect favorite",
    });
    const matchingNotFavorite = await repos.threads.create({
      projectId: "project",
      userId: "user",
      title: "Sect draft",
    });
    const otherWorkFavorite = await repos.threads.create({
      projectId: "project",
      userId: "user",
      title: "Sect in another Work",
    });
    await repos.threadWorks.addMembership(matchingFavorite.id as ThreadId, work.id, true);
    await repos.threadWorks.addMembership(matchingNotFavorite.id as ThreadId, work.id, true);
    await repos.threadWorks.addMembership(otherWorkFavorite.id as ThreadId, otherWork.id, true);
    await repos.threadUserState.update({
      threadId: matchingFavorite.id as ThreadId,
      userId: "user" as UserId,
      isFavorite: true,
    });
    await repos.threadUserState.update({
      threadId: otherWorkFavorite.id as ThreadId,
      userId: "user" as UserId,
      isFavorite: true,
    });

    const input = {
      repository: repos.chatFeed,
      works,
      projectId: "project",
      userId: "user",
      workId: work.id,
    };

    expect((await getProjectChatFeedPage(input)).items.map((item) => item.title).sort()).toEqual([
      "Sect draft",
      "Sect favorite",
    ]);
    expect(
      (await getProjectChatFeedPage({ ...input, search: "sect", favorite: true })).items.map(
        (item) => item.title,
      ),
    ).toEqual(["Sect favorite"]);
  });

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

  it("rejects a nonexistent Work", async () => {
    const works = createInMemoryWorkRepository();
    const repos = createInMemoryRepositories({ works });

    await expect(
      getProjectChatFeedPage({
        repository: repos.chatFeed,
        works,
        projectId: "project",
        userId: "user",
        workId: "00000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toBeInstanceOf(ProjectChatFeedWorkUnavailableError);
  });
});
