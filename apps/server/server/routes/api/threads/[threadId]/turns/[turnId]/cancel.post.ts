/** POST /api/threads/[threadId]/turns/[turnId]/cancel: cancels an in-flight turn on an owned thread. Depends on the auth gate, thread ownership, and the turn runner. */
import { defineEventHandler, getRouterParam } from "nitro/h3";
import { requireThreadOwner } from "../../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { threadRepos, runner } = app;
  const { userId } = user;
  const threadId = getRouterParam(event, "threadId") ?? "";
  const turnId = requireRequestId(getRouterParam(event, "turnId"), "turnId");

  const thread = await requireThreadOwner({ threads: threadRepos.threads }, threadId, userId);
  let status = await runner.cancel(thread.id, turnId);
  if (status === "already_finished") {
    const ask = await threadRepos.asks.findOpenByThread(thread.id);
    if (ask?.askingTurnId === turnId && (await app.asks.cancelOpen(thread.id, ask.id)).ok)
      status = "cancelled";
  }
  // A turn owns only the subagents its execution spawned (and its own question).
  if (status === "cancelled")
    await runner.cancelLineage({ kind: "turn", threadId: thread.id, turnId });

  return { threadId: thread.id, turnId, status };
});
