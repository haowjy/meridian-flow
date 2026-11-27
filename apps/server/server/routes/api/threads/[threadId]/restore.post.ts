import type { CommandId, ProjectId } from "@meridian/contracts";
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireThreadOwner, setOwnedThreadTrashState } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { runRouteCommand, splitCommandBody } from "../../../../lib/command-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  const { commandId, body } = splitCommandBody(await readBody(event));
  const thread = await requireThreadOwner(
    { threads: app.threadRepos.threads },
    threadId,
    user.userId,
    { includeDeleted: true },
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
      projectId: thread.projectId as ProjectId,
      kind: "chat_restore",
      selectors: { threadId: thread.id },
      body,
    },
    async () => {
      const { changed, keptWith } = await setOwnedThreadTrashState(
        {
          repos: app.threadRepos,
          projects: app.projectRepo,
          workContextNotices: app.workContextNotices,
          workAuthorityResolver: app.workAuthorityResolver,
          works: app.workRepo,
          stopThreads: app.stopThreads,
        },
        thread.id,
        user.userId,
        "visible",
      );
      return { status: "done", changed, keptWith: keptWith ?? null };
    },
    () => undefined,
  );
  if (result.changed) await app.workContextNotices.materializeIdle(thread.id);
  app.projectWakeHub.publish({ type: "project-chats-hint", projectId: thread.projectId });
  return serializeTransport(result);
});
