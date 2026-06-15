/** POST /api/threads: creates a thread (project resolved from the request) via the thread-creation helper. Depends on the auth gate. */
import { type CreateThreadRequest, serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { AgentBindingNotFoundError, createThreadForProject } from "../../../lib/thread-creation.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos, projectRepo, workRepo } = app;
  const { userId } = user;
  const body = (await readBody<CreateThreadRequest>(event)) ?? ({} as CreateThreadRequest);
  if (!body.projectId) {
    throw createError({ statusCode: 400, message: "projectId is required" });
  }

  try {
    const thread = await createThreadForProject(
      {
        projects: projectRepo,
        workRepo,
        threads: repos.threads,
        threadWorks: repos.threadWorks,
        transaction: repos.transaction,
        packageRepository: app.packageRepository,
        eventSink: app.eventSink,
      },
      {
        projectId: body.projectId,
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
