/** POST /api/threads: creates a thread (workbench resolved from the request) via the thread-creation helper. Depends on the auth gate. */
import { type CreateThreadRequest, serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
import {
  AgentBindingNotFoundError,
  createThreadForWorkbench,
} from "../../../lib/thread-creation.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos, workbenchRepo, workRepo } = app;
  const { userId } = user;
  const body = (await readBody<CreateThreadRequest>(event)) ?? ({} as CreateThreadRequest);
  if (!body.workbenchId) {
    throw createError({ statusCode: 400, message: "workbenchId is required" });
  }

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
        workbenchId: body.workbenchId,
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
