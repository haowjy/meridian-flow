/** GET project chat feed: owner-gated, cursor-paginated, optionally filtered by Work, Favorites, and title search. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/index.js";
import {
  getProjectChatFeedPage,
  ProjectChatFeedWorkUnavailableError,
} from "../../../../domains/threads/domain/chat-feed.js";
import { InvalidChatFeedCursorError } from "../../../../domains/threads/domain/chat-feed-page.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { isUuid } from "../../../../shared/uuid.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const { cursor: cursorValue, favorite, q, workId } = getQuery(event);
  if (favorite !== undefined && favorite !== "true") {
    throw createError({ statusCode: 400, statusMessage: "Invalid Favorites filter" });
  }
  if (q !== undefined && typeof q !== "string") {
    throw createError({ statusCode: 400, statusMessage: "Invalid chat search" });
  }
  if (workId !== undefined && (typeof workId !== "string" || !isUuid(workId))) {
    throw createError({ statusCode: 400, statusMessage: "Invalid Work ID" });
  }
  if (!isUuid(projectId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid project ID" });
  }
  if (Array.isArray(cursorValue)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid chat feed cursor" });
  }
  try {
    await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
    return serializeTransport(
      await getProjectChatFeedPage({
        repository: app.repos.chatFeed,
        works: app.workRepo,
        projectId,
        userId: user.userId,
        cursor: cursorValue,
        favorite: favorite === "true",
        search: q ?? null,
        workId: workId ?? null,
      }),
    );
  } catch (cause) {
    if (cause instanceof InvalidChatFeedCursorError) {
      throw createError({ statusCode: 400, statusMessage: cause.message });
    }
    if (cause instanceof ProjectChatFeedWorkUnavailableError) {
      throw createError({ statusCode: 404, statusMessage: "Work not found" });
    }
    throw cause;
  }
});
