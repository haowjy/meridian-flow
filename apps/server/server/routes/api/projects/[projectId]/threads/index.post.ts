/** POST /api/projects/[projectId]/threads: creates a thread in a project (with ownership + work attachment). Depends on the auth gate and the thread-creation helper. */
import { type CreateThreadRequest, serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  parseOptionalRequestId,
  requireAgentSelection,
  requireRequestId,
} from "../../../../../lib/request-id.js";
import { createThreadForProject } from "../../../../../lib/thread-creation.js";

import {
  parseCreationTitle,
  throwThreadCreationError,
} from "../../../../../lib/thread-creation-http.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos, projectRepo, workRepo } = app;
  const { userId } = user;
  const projectId = requireRequestId(getRouterParam(event, "projectId"), "projectId");
  const body = (await readBody<CreateThreadRequest>(event)) ?? ({} as CreateThreadRequest);

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
        projectId,
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
