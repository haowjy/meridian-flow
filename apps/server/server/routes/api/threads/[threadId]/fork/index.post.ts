/** POST /api/threads/[threadId]/fork: create a new primary thread from a fork point. */

import { forkThreadRequestSchema, serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { forkThreadAgent, type ThreadAgentSwapDeps } from "../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { deriveConversationErrorStatus } from "../../../../../lib/derive-conversation-route-errors.js";
import { parseNullableRequestId, requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  const parsed = forkThreadRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: "Invalid fork request" });
  }
  const body = parsed.data;
  try {
    const result = await forkThreadAgent(
      {
        threads: app.repos.threads as ThreadAgentSwapDeps["threads"],
        threadWorks: app.repos.threadWorks,
        turns: app.repos.turns,
        promptBakes: app.repos.promptBakes,
        blocks: app.repos.blocks,
        imageInclusions: app.repos.imageInclusions,
        threadDocuments: app.repos.threadDocuments,
        transaction: app.repos.transaction,
        projects: app.projectRepo,
        works: app.workRepo,
        workContextNotices: app.workContextNotices,
        agentCatalog: app.agentCatalog,
        agentRevisions: app.agentRevisions,
        eventWriter: app.journalWriter,
      },
      {
        id: requireRequestId(body.id, "id"),
        threadId,
        userId: user.userId,
        originTurnId: parseNullableRequestId(body.originTurnId, "originTurnId"),
      },
    );
    event.res.status = result.created ? 201 : 200;
    return serializeTransport(result.thread);
  } catch (error) {
    const statusCode = deriveConversationErrorStatus(error);
    if (statusCode !== null && error instanceof Error)
      throw createError({ statusCode, message: error.message });
    throw error;
  }
});
