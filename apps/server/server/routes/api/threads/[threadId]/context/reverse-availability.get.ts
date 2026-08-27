import type { ThreadId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireThreadOwner } from "../../../../../domains/threads/index.js";
import type { AppServices } from "../../../../../lib/app.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";
import { readThreadContextDocument } from "../../../../../lib/thread-context-route.js";
import { getWorkReceiptReversalAvailability } from "../../../../../lib/work-receipt-reversal.js";

type AvailabilityRouteServices = {
  contextPorts: AppServices["contextPorts"];
  threads: AppServices["threadRepos"]["threads"];
  threadWorks: AppServices["threadRepos"]["threadWorks"];
  works: AppServices["workRepo"];
  documentSync: AppServices["documentSync"];
  projects: AppServices["projectRepo"];
  blocks: AppServices["threadRepos"]["blocks"];
  turns: AppServices["threadRepos"]["turns"];
};

function selectAvailabilityRouteServices(app: AppServices): AvailabilityRouteServices {
  return {
    contextPorts: app.contextPorts,
    threads: app.threadRepos.threads,
    threadWorks: app.threadRepos.threadWorks,
    works: app.workRepo,
    documentSync: app.documentSync,
    projects: app.projectRepo,
    blocks: app.threadRepos.blocks,
    turns: app.threadRepos.turns,
  };
}

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const services = selectAvailabilityRouteServices(app);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId") as ThreadId;
  const { uri, target } = getQuery(event);
  if (typeof target === "string" && target.length > 0) {
    await requireThreadOwner(
      { threads: services.threads, projects: services.projects },
      threadId,
      user.userId,
    );
    return getWorkReceiptReversalAvailability(
      {
        blocks: services.blocks,
        turns: services.turns,
        works: services.works,
        threads: services.threads,
        threadWorks: services.threadWorks,
      },
      { threadId, turnId: requireRequestId(target, "target") },
    );
  }
  if (typeof uri !== "string" || uri.length === 0) {
    throw createError({ statusCode: 400, message: "uri or target is required" });
  }

  const document = await readThreadContextDocument(
    {
      contextPorts: services.contextPorts,
      threads: services.threads,
      threadWorks: services.threadWorks,
      works: services.works,
    },
    { threadId, userId: user.userId, uri },
  );
  if (!document.documentId) {
    throw createError({ statusCode: 404, message: "Document not found" });
  }
  return services.documentSync.agentEdit().getAvailability(document.documentId, threadId);
});
