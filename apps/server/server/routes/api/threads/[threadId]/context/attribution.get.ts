import type { ThreadId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import type { DocumentAttribution } from "../../../../../domains/collab/index.js";
import type { AppServices } from "../../../../../lib/app.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { readThreadContextDocument } from "../../../../../lib/thread-context-route.js";

type AttributionRouteServices = {
  contextPorts: AppServices["contextPorts"];
  threads: AppServices["threadRepos"]["threads"];
  threadWorks: AppServices["threadRepos"]["threadWorks"];
  documentSync: DocumentAttribution;
};

function selectAttributionRouteServices(app: AppServices): AttributionRouteServices {
  return {
    contextPorts: app.contextPorts,
    threads: app.threadRepos.threads,
    threadWorks: app.threadRepos.threadWorks,
    documentSync: app.documentSync,
  };
}

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const services = selectAttributionRouteServices(app);
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
  const attribution = await services.documentSync.getLastUpdateAttribution(document.documentId);
  return {
    documentId: document.documentId,
    uri,
    ...attribution,
  };
});
