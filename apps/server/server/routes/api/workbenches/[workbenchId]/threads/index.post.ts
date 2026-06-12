/** POST /api/workbenches/[workbenchId]/threads: creates a thread in a workbench (with ownership + work attachment). Depends on the auth gate and the thread-creation helper. */
import { type CreateThreadRequest, serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  AgentBindingNotFoundError,
  createThreadForWorkbench,
} from "../../../../../lib/thread-creation.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos, workbenchRepo, workRepo } = app;
  const { userId } = user;
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const body = (await readBody<CreateThreadRequest>(event)) ?? { workbenchId };

  try {
    const thread = await createThreadForWorkbench(
      {
        workbenches: workbenchRepo,
        workRepo,
        threads: repos.threads,
        packageRepository: app.packageRepository,
        eventSink: app.eventSink,
      },
      {
        workbenchId,
        userId,
        id: body.id,
        title: body.title ?? null,
        systemPrompt: body.systemPrompt ?? null,
        currentAgent: body.currentAgent ?? null,
        workId: body.workId ?? null,
      },
    );

    event.res.status = 201;
    return serializeTransport(thread);
  } catch (error) {
    // An unresolvable agent slug is a client error, not a server fault.
    if (error instanceof AgentBindingNotFoundError) {
      throw createError({ statusCode: 400, message: error.message });
    }
    throw error;
  }
});
