/**
 * POST /api/threads/[threadId]/turns/[turnId]/restore-delete: the writer
 * restores a document the agent deleted live in this turn, named by the
 * delete receipt's `documentId`. 409 when its location is taken or its
 * folder is gone.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, readBody, setResponseStatus } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { restoreAgentDelete } from "../../../../../../lib/thread-context-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = (await readBody<{ documentId?: unknown }>(event)) ?? {};
  const result = await restoreAgentDelete(
    {
      contextPorts: app.contextPorts,
      fileAccess: app.fileAccess,
      threads: app.threadRepos.threads,
      threadWorks: app.threadRepos.threadWorks,
      works: app.workRepo,
      workAuthorityResolver: app.workAuthorityResolver,
      namespaceChanges: app.namespaceChanges,
    },
    {
      threadId: (getRouterParam(event, "threadId") ?? "") as ThreadId,
      turnId: getRouterParam(event, "turnId") ?? "",
      documentId: typeof body.documentId === "string" ? body.documentId : "",
      userId: user.userId,
    },
  );
  if (result.status !== "restored") setResponseStatus(event, 409);
  return result;
});
