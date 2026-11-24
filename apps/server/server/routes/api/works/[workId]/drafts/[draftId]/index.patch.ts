import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";
import {
  draftIdParam,
  draftName,
  runDraftCommand,
} from "../../../../../../lib/work-drafts-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const draftId = draftIdParam(getRouterParam(event, "draftId"));
  return runDraftCommand(
    app,
    {
      workId: getRouterParam(event, "workId"),
      userId: user.userId,
      kind: "draft_rename",
      rawBody: await readBody(event),
      draftId,
    },
    (work, body) =>
      app.documentSync.workDrafts.rename({ workId: work.id, draftId, name: draftName(body.name) }),
  );
});
