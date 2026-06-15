import type { ThreadId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { readThreadContextDocument } from "../../../../../lib/thread-context-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = (getRouterParam(event, "threadId") ?? "") as ThreadId;
  const uri = getQuery(event).uri;
  if (typeof uri !== "string" || uri.length === 0) {
    throw createError({ statusCode: 400, message: "uri is required" });
  }

  const document = await readThreadContextDocument(
    {
      contextPorts: app.contextPorts,
      threads: app.threadRepos.threads,
      threadWorks: app.threadRepos.threadWorks,
    },
    { threadId, userId: user.userId, uri },
  );
  if (!document.documentId) {
    throw createError({ statusCode: 404, message: "Document not found" });
  }
  const attribution = await app.documentSync.getLastUpdateAttribution(document.documentId);
  return {
    documentId: document.documentId,
    uri,
    ...attribution,
  };
});
