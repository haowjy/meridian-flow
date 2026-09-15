/** POST /api/threads/[threadId]/handoff: create a new primary thread with a summary brief. */

import type { AgentSelection } from "@meridian/contracts/agents";
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { AgentSelectionError } from "../../../../../domains/packages/index.js";
import {
  handoffThreadAgent,
  type ThreadAgentSwapDeps,
} from "../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireAgentSelection, requireRequestId } from "../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId");
  const body =
    (await readBody<{ agentSelection?: AgentSelection; summary?: string | null }>(event)) ?? {};
  try {
    const thread = await handoffThreadAgent(
      {
        threads: app.repos.threads as ThreadAgentSwapDeps["threads"],
        threadWorks: app.repos.threadWorks,
        turns: app.repos.turns,
        blocks: app.repos.blocks,
        threadDocuments: app.repos.threadDocuments,
        transaction: app.repos.transaction,
        projects: app.projectRepo,
        agentCatalog: app.agentCatalog,
        agentRevisions: app.agentRevisions,
        eventWriter: app.journalWriter,
      },
      {
        threadId,
        userId: user.userId,
        agentSelection: requireAgentSelection(body.agentSelection),
        summary: body.summary,
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
