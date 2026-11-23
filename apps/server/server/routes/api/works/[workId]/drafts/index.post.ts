/** POST /api/works/:workId/drafts: `+ New draft`, as a command. */
import { isDraftId } from "@meridian/contracts";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { draftName, runDraftCommand } from "../../../../../lib/work-drafts-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const rawBody = await readBody(event);
  const draftId = (rawBody as { draftId?: unknown } | null)?.draftId;
  if (draftId !== undefined && !isDraftId(draftId))
    throw createError({ statusCode: 400, message: "draftId must be a draft id" });
  event.res.status = 201;
  return runDraftCommand(
    app,
    { workId: getRouterParam(event, "workId"), userId: user.userId, kind: "draft_create", rawBody },
    (work, body) =>
      app.documentSync.workDrafts.create({
        workId: work.id,
        ...(draftId !== undefined ? { draftId } : {}),
        name: draftName(body.name),
        userId: user.userId,
      }),
  );
});
