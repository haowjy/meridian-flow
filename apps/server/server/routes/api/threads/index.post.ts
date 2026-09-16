/** POST /api/threads: creates a thread (project resolved from the request) via the thread-creation helper. Depends on the auth gate. */
import { type CreateThreadRequest, serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
import {
  parseOptionalRequestId,
  requireAgentSelection,
  requireRequestId,
} from "../../../lib/request-id.js";
import { createThreadForProject } from "../../../lib/thread-creation.js";

import { parseCreationTitle, throwThreadCreationError } from "../../../lib/thread-creation-http.js";

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
        agentRevisions: app.agentRevisions,
        agentCatalog: app.agentCatalog,
        eventSink: app.eventSink,
      },
      {
        projectId: requireRequestId(body.projectId, "projectId"),
        userId,
        id: parseOptionalRequestId(body.id, "id"),
        title: parseCreationTitle(body.title),
        agentSelection: requireAgentSelection(body.agentSelection),
        workId: body.workId == null ? null : parseOptionalRequestId(body.workId, "workId"),
      },
    );

    event.res.status = 201;
    return serializeTransport(thread);
  } catch (error) {
    throwThreadCreationError(error);
  }
});
