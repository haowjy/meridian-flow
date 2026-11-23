/** DELETE /api/works/:workId/drafts/:draftId: `Delete draft`, as a command; `restore` is its Undo. */
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
      kind: "draft_delete",
      rawBody: await readBody(event),
      draftId,
    },
    async (work) => {
      await app.documentSync.workDrafts.remove({ workId: work.id, draftId, userId: user.userId });
      return null;
    },
  );
});
