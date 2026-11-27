import type { CommandId } from "@meridian/contracts";
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { findTrashTarget, setOwnedThreadTrashState } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { runRouteCommand, splitCommandBody } from "../../../../lib/command-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { commandId, body } = splitCommandBody(await readBody(event));
  const { threadId, thread, projectId } = await findTrashTarget(
    { threads: app.threadRepos.threads, projects: app.projectRepo },
    getRouterParam(event, "threadId") ?? "",
    user.userId,
    body.projectId,
  );
  const result = await runRouteCommand<{
    status: "done";
    changed: boolean;
    keptWith: { workId: string; name: string } | null;
  }>(
    app.commands,
    {
      commandId: commandId as CommandId,
      userId: user.userId,
      projectId,
      kind: "chat_restore",
      selectors: { threadId },
      body,
    },
    async () => {
      if (!thread) return { status: "done", changed: false, keptWith: null };
      const { changed, keptWith } = await setOwnedThreadTrashState(
        {
          repos: app.threadRepos,
          projects: app.projectRepo,
          workContextNotices: app.workContextNotices,
          workAuthorityResolver: app.workAuthorityResolver,
          works: app.workRepo,
          stopThreads: app.stopThreads,
        },
        threadId,
        user.userId,
        "visible",
      );
      return { status: "done", changed, keptWith: keptWith ?? null };
    },
    () => undefined,
  );
  if (result.changed) await app.workContextNotices.materializeIdle(threadId);
  app.projectWakeHub.publish({ type: "project-chats-hint", projectId });
  return serializeTransport(result);
});
