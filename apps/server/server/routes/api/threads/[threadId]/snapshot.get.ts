import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { buildThreadSnapshot, requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { threadRepos, threadEventHub, threadRuntime } = app;
  const { userId } = user;
  const threadId = getRouterParam(event, "threadId") ?? "";

  const thread = await requireThreadOwner({ threads: threadRepos.threads }, threadId, userId);
  return serializeTransport(
    await buildThreadSnapshot(threadRepos, threadEventHub, threadRuntime, thread.id),
  );
});
