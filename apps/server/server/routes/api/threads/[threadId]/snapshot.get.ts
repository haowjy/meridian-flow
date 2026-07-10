/** GET /api/threads/[threadId]/snapshot: returns the full thread snapshot for an initial client load. Depends on the auth gate, thread ownership, and the snapshot builder. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { buildThreadSnapshot, requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { repos, projectRepo, hub, runner } = app;
  const { userId } = user;
  const threadId = getRouterParam(event, "threadId") ?? "";

  await requireThreadOwner({ threads: repos.threads, projects: projectRepo }, threadId, userId);
  return serializeTransport(await buildThreadSnapshot(repos, hub, runner, threadId, userId));
});
