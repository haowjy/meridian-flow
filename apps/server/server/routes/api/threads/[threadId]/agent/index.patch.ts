/** PATCH /api/threads/[threadId]/agent: rebind agent on an un-started owned thread. */
import { serializeTransport, type UpdateThreadAgentRequest } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { throwHttpInterruptForStatus } from "../../../../../lib/interrupt-boundary.js";
import {
  rebindThreadAgent,
  ThreadAlreadyStartedError,
} from "../../../../../lib/thread-agent-rebind.js";
import { AgentBindingNotFoundError } from "../../../../../lib/thread-creation.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  const body = (await readBody<UpdateThreadAgentRequest>(event)) ?? {
    currentAgent: null,
  };

  if (body.currentAgent !== null && typeof body.currentAgent !== "string") {
    throwHttpInterruptForStatus(400, "currentAgent must be a string or null");
  }

  try {
    const thread = await rebindThreadAgent(
      {
        threads: app.repos.threads,
        projects: app.projectRepo,
        packageRepository: app.packageRepository,
      },
      {
        threadId,
        userId: user.userId,
        currentAgent: body.currentAgent ?? null,
      },
    );
    return serializeTransport(thread);
  } catch (error) {
    if (error instanceof AgentBindingNotFoundError) {
      throwHttpInterruptForStatus(400, error.message);
    }
    if (error instanceof ThreadAlreadyStartedError) {
      throwHttpInterruptForStatus(409, error.message);
    }
    throw error;
  }
});
