/** POST /api/threads/[threadId]/handoff: create a new primary thread with a pending brief seed. */

import { handoffThreadRequestSchema, serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import {
  handoffThreadAgent,
  type ThreadAgentSwapDeps,
} from "../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { deriveConversationErrorStatus } from "../../../../../lib/derive-conversation-route-errors.js";
import { requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  const parsed = handoffThreadRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "Invalid handoff request" });
  const body = parsed.data;
  try {
    const result = await handoffThreadAgent(
      {
        handoffBriefs: app.handoffBriefs,
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
        id: body.id,
        originTurnId: body.originTurnId,
        threadId,
        userId: user.userId,
        agentSelection: body.agentSelection,
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
