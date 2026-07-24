/** Reads a trail's protected document detail after thread and per-document gates. */
import type { ChangeTrailDetailResponseV1 } from "@meridian/contracts";
import type { ThreadId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireThreadOwner } from "../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = (getRouterParam(event, "threadId") ?? "") as ThreadId;
  const trailId = getRouterParam(event, "trailId") ?? "";
  await requireThreadOwner(
    { threads: app.threadRepos.threads, projects: app.projectRepo },
    threadId,
    user.userId,
  );
  return {
    version: 1,
    trailId,
    documents: await app.changeTrails.readDetails({ threadId, trailId, userId: user.userId }),
  } satisfies ChangeTrailDetailResponseV1;
});
