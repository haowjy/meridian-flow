/** Lists live conversations associated with this owned Work. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireWorkOwner } from "../../../../domains/projects/index.js";
import {
  getWorkChatFeedPage,
  InvalidWorkChatFeedCursorError,
} from "../../../../domains/threads/domain/work-chat-feed.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const workId = requireRequestId(getRouterParam(event, "workId"), "workId");
  const cursor = getQuery(event).cursor;
  if (Array.isArray(cursor))
    throw createError({ statusCode: 400, statusMessage: "Invalid Work chat cursor" });
  try {
    const work = await requireWorkOwner(
      { works: app.workRepo, projects: app.projectRepo },
      workId,
      user.userId,
    );
    return serializeTransport(
      await getWorkChatFeedPage({
        repository: app.repos.workChatFeed,
        projectId: work.projectId,
        workId,
        userId: user.userId,
        cursor,
      }),
    );
  } catch (cause) {
    if (cause instanceof InvalidWorkChatFeedCursorError)
      throw createError({ statusCode: 400, statusMessage: cause.message });
    throw cause;
  }
});
