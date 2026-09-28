/** Cursor and page policy for the server-owned Project chat feed. */

import type { WorkId } from "@meridian/contracts/runtime";
import type { ProjectChatFeedPage } from "@meridian/contracts/threads";
import type { WorkRepository } from "../../projects/index.js";
import type { ProjectChatFeedRepository } from "../ports/repositories.js";
import { getChatFeedPage } from "./chat-feed-page.js";

const PAGE_SIZE = 24;
const MAX_SEARCH_LENGTH = 200;

export class ProjectChatFeedWorkUnavailableError extends Error {
  constructor() {
    super("Work is not available in this project");
    this.name = "ProjectChatFeedWorkUnavailableError";
  }
}

export async function getProjectChatFeedPage(input: {
  repository: ProjectChatFeedRepository;
  works: Pick<WorkRepository, "findById">;
  projectId: string;
  userId: string;
  cursor?: string | null;
  favorite?: boolean;
  search?: string | null;
  workId: WorkId | null;
}): Promise<ProjectChatFeedPage> {
  const workId = input.workId;
  if (workId) {
    const work = await input.works.findById(workId);
    if (!work || work.projectId !== input.projectId || work.deletedAt) {
      throw new ProjectChatFeedWorkUnavailableError();
    }
  }
  const search = input.search?.trim().slice(0, MAX_SEARCH_LENGTH) || null;
  return getChatFeedPage({
    cursor: input.cursor,
    invalidCursorMessage: "Invalid Project chat cursor",
    pageSize: PAGE_SIZE,
    fetchPage: (after, limit) =>
      input.repository.queryPage({
        projectId: input.projectId,
        userId: input.userId,
        after,
        limit,
        favorite: input.favorite ?? false,
        workId,
        search,
      }),
  });
}
