/** Route for the transcript receipt chip's degraded View-change diff payload. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { defineEventHandler, getRouterParam, setResponseStatus } from "nitro/h3";
import { requireThreadOwner } from "../../../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = (getRouterParam(event, "threadId") ?? "") as ThreadId;
  const turnId = (getRouterParam(event, "turnId") ?? "") as TurnId;
  await requireThreadOwner(
    { threads: app.threadRepos.threads, projects: app.projectRepo },
    threadId,
    user.userId,
  );
  const shell = (await app.changeTrails.listShells(threadId)).find(
    (candidate) => candidate.owner.kind === "turn" && candidate.owner.turnId === turnId,
  );
  const diff = shell
    ? {
        version: 1 as const,
        shell,
        documents: await app.changeTrails.readDetails({
          threadId,
          trailId: shell.trailId,
          userId: user.userId,
        }),
      }
    : null;
  setResponseStatus(event, 200);
  return diff;
});
