/**
 * POST /api/threads/[threadId]/turns/[turnId]/restore-delete: the writer
 * restores a document the agent deleted live in this turn, named by the
 * delete receipt's `documentId`. 409 when its location is taken, its folder
 * is gone, or the turn has no delete of it still applied (`nothing_to_restore`).
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import { z } from "zod";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { restoreAgentDelete } from "../../../../../../lib/thread-context-route.js";

const restoreBodySchema = z.object({
  documentId: z
    .string({ error: "documentId must be a non-empty string" })
    .min(1, "documentId must be a non-empty string"),
});

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const parsed = restoreBodySchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: parsed.error.issues[0]?.message });
  }
  const result = await restoreAgentDelete(
    {
      contextPorts: app.contextPorts,
      fileAccess: app.fileAccess,
      threads: app.threadRepos.threads,
      threadWorks: app.threadRepos.threadWorks,
      works: app.workRepo,
      workAuthorityResolver: app.workAuthorityResolver,
      namespaceChanges: app.documentSync.namespaceChanges,
    },
    {
      threadId: (getRouterParam(event, "threadId") ?? "") as ThreadId,
      turnId: getRouterParam(event, "turnId") ?? "",
      documentId: parsed.data.documentId,
      userId: user.userId,
    },
  );
  if (result.status !== "restored" && result.status !== "already_restored")
    setResponseStatus(event, result.status === "permission_denied" ? 403 : 409);
  return result;
});
