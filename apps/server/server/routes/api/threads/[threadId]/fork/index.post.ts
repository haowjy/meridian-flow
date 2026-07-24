/** POST /api/threads/[threadId]/fork: create a new primary thread from a fork point. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { parseNullableRequestId, requireRequestId } from "../../../../../lib/request-id.js";
import { forkThreadAgent, type ThreadAgentSwapDeps } from "../../../../../lib/thread-agent-swap.js";
import { AgentBindingNotFoundError } from "../../../../../lib/thread-creation.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  const body =
    (await readBody<{ targetAgent?: string | null; originTurnId?: string | null }>(event)) ?? {};
  try {
    const thread = await forkThreadAgent(
      {
        threads: app.repos.threads as ThreadAgentSwapDeps["threads"],
        threadWorks: app.repos.threadWorks,
        turns: app.repos.turns,
        blocks: app.repos.blocks,
        threadDocuments: app.repos.threadDocuments,
        transaction: app.repos.transaction,
        projects: app.projectRepo,
        packageRepository: app.packageRepository,
        eventWriter: app.journalWriter,
      },
      {
        threadId,
        userId: user.userId,
        targetAgent: body.targetAgent ?? null,
        originTurnId: parseNullableRequestId(body.originTurnId, "originTurnId"),
      },
    );
    event.res.status = 201;
    return serializeTransport(thread);
  } catch (error) {
    if (error instanceof AgentBindingNotFoundError)
      throw createError({ statusCode: 400, message: error.message });
    throw error;
  }
});
