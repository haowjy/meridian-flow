import type { ThreadId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import type { AppServices } from "../../../../../lib/app.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { readThreadContextDocument } from "../../../../../lib/thread-context-route.js";

type AvailabilityRouteServices = {
  contextPorts: AppServices["contextPorts"];
  threads: AppServices["threadRepos"]["threads"];
  threadWorks: AppServices["threadRepos"]["threadWorks"];
  documentSync: AppServices["documentSync"];
};

function selectAvailabilityRouteServices(app: AppServices): AvailabilityRouteServices {
  return {
    contextPorts: app.contextPorts,
    threads: app.threadRepos.threads,
    threadWorks: app.threadRepos.threadWorks,
    documentSync: app.documentSync,
  };
}

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const services = selectAvailabilityRouteServices(app);
  const threadId = (getRouterParam(event, "threadId") ?? "") as ThreadId;
  const uri = getQuery(event).uri;
  if (typeof uri !== "string" || uri.length === 0) {
    throw createError({ statusCode: 400, message: "uri is required" });
  }

  const document = await readThreadContextDocument(
    {
      contextPorts: services.contextPorts,
      threads: services.threads,
      threadWorks: services.threadWorks,
    },
    { threadId, userId: user.userId, uri },
  );
  if (!document.documentId) {
    throw createError({ statusCode: 404, message: "Document not found" });
  }
  return services.documentSync.agentEdit().getAvailability(document.documentId, threadId);
});
