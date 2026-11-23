/** POST /api/works/:workId/drafts/:draftId/restore: the Undo of `Delete draft`, as a command. */
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import { draftIdParam, runDraftCommand } from "../../../../../../lib/work-drafts-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const draftId = draftIdParam(getRouterParam(event, "draftId"));
  return runDraftCommand(
    app,
    {
      workId: getRouterParam(event, "workId"),
      userId: user.userId,
      kind: "draft_restore",
      rawBody: await readBody(event),
      draftId,
    },
    (work) => app.documentSync.workDrafts.restore({ workId: work.id, draftId }),
  );
});
