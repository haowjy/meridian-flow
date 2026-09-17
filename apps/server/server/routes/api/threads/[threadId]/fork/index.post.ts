/** POST /api/threads/[threadId]/fork: create a new primary thread from a fork point. */

import type { AgentSelection } from "@meridian/contracts/agents";
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { AgentSelectionError } from "../../../../../domains/packages/index.js";
import { forkThreadAgent, type ThreadAgentSwapDeps } from "../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  parseNullableRequestId,
  requireAgentSelection,
  requireRequestId,
} from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  const body =
    (await readBody<{ agentSelection?: AgentSelection; originTurnId?: string | null }>(event)) ??
    {};
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
        works: app.workRepo,
        agentCatalog: app.agentCatalog,
        agentRevisions: app.agentRevisions,
        eventWriter: app.journalWriter,
      },
      {
        threadId,
        userId: user.userId,
        agentSelection: requireAgentSelection(body.agentSelection),
        originTurnId: parseNullableRequestId(body.originTurnId, "originTurnId"),
      },
    );
    event.res.status = 201;
    return serializeTransport(thread);
  } catch (error) {
    if (error instanceof AgentSelectionError)
      throw createError({ statusCode: 400, message: error.message });
    throw error;
  }
});
