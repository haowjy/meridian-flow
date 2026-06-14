/** POST /api/threads/[threadId]/handoff: create a new primary thread with a summary brief. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handoffThreadAgent,
  type ThreadAgentSwapDeps,
} from "../../../../../lib/thread-agent-swap.js";
import { AgentBindingNotFoundError } from "../../../../../lib/thread-creation.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  const body =
    (await readBody<{ targetAgent?: string | null; summary?: string | null }>(event)) ?? {};
  try {
    const thread = await handoffThreadAgent(
      {
        threads: app.repos.threads as ThreadAgentSwapDeps["threads"],
        turns: app.repos.turns,
        blocks: app.repos.blocks,
        threadDocuments: app.repos.threadDocuments,
        projects: app.projectRepo,
        packageRepository: app.packageRepository,
        eventWriter: app.journalWriter,
      },
      {
        threadId,
        userId: user.userId,
        targetAgent: body.targetAgent ?? null,
        summary: body.summary,
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
