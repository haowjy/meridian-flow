/** POST /api/threads/[threadId]/restore: restores an owned thread from trash idempotently. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { restoreOwnedThreadFromTrash } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  const thread = await restoreOwnedThreadFromTrash(
    {
      repos: app.repos,
      projects: app.projectRepo,
      obligations: app.repos.workContextDeliveries,
      workContextDelivery: app.workContextDelivery,
    },
    threadId,
    user.userId,
  );
  return serializeTransport(thread);
});
