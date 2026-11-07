/** HTTP edge for moving or renaming one entry by id. */

import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import { handleContextMoveRequest } from "../../../../../../../lib/context-move-route.js";
import { requireRequestId } from "../../../../../../../lib/request-id.js";
import { withDurableIntentInterruptBoundary } from "../../../../../../../shared/interrupt-boundary.js";

export default defineEventHandler((event) =>
  withDurableIntentInterruptBoundary(async () => {
    const { app, user } = await requireAppUser(event);
    return handleContextMoveRequest(
      {
        fileAccess: app.fileAccess,
        projectRepo: app.projectRepo,
        contextPorts: app.contextPorts,
        workAuthorityResolver: app.workAuthorityResolver,
        availability: app.projectContextAvailability,
      },
      {
        projectId: getRouterParam(event, "projectId") ?? "",
        userId: user.userId,
        entryId: requireRequestId(getRouterParam(event, "entryId"), "entryId"),
        body: await readBody(event),
      },
    );
  }),
);
