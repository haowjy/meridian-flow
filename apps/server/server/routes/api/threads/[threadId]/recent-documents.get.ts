import type { ListThreadRecentDocumentsResponse } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

function parseLimit(raw: unknown): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
export default defineEventHandler(async (event): Promise<ListThreadRecentDocumentsResponse> => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  await requireThreadOwner(
    { threads: app.repos.threads, projects: app.projectRepo },
    threadId,
    user.userId,
  );
  const touches = await app.repos.documentTouches.listByThread(
    threadId,
    parseLimit(getQuery(event).limit),
  );
  return { documents: await app.uploadDocuments.listRecent(touches) };
});
