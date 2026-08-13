/** GET project Home feed: owner-gated, cursor-paginated server projection. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/index.js";
import {
  decodeHomeFeedCursor,
  getHomeChatFeedPage,
  InvalidHomeFeedCursorError,
} from "../../../../domains/threads/domain/home-feed.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { isUuid } from "../../../../shared/uuid.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const cursorValue = getQuery(event).cursor;
  if (!isUuid(projectId)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid project ID" });
  }
  if (Array.isArray(cursorValue)) {
    throw createError({ statusCode: 400, statusMessage: "Invalid Home feed cursor" });
  }
  try {
    if (cursorValue !== undefined) decodeHomeFeedCursor(cursorValue);
    await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
    return serializeTransport(
      await getHomeChatFeedPage({
        repository: app.repos.homeFeed,
        projectId,
        userId: user.userId,
        cursor: cursorValue,
      }),
    );
  } catch (cause) {
    if (cause instanceof InvalidHomeFeedCursorError) {
      throw createError({ statusCode: 400, statusMessage: cause.message });
    }
    throw cause;
  }
});
