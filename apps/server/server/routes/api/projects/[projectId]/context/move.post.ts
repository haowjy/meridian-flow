/** HTTP edge for a move of one document between a project's files and the account's. */

import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { handleContextMoveRequest } from "../../../../../lib/context-move-route.js";
import { withDurableIntentInterruptBoundary } from "../../../../../shared/interrupt-boundary.js";

export default defineEventHandler((event) =>
  withDurableIntentInterruptBoundary(async () => {
    const { app, user } = await requireAppUser(event);
    return handleContextMoveRequest(
      {
        fileAccess: app.fileAccess,
        projectRepo: app.projectRepo,
        contextPorts: app.contextPorts,
        workAuthorityResolver: app.workAuthorityResolver,
      },
      {
        projectId: getRouterParam(event, "projectId") ?? "",
        userId: user.userId,
        body: await readBody(event),
      },
    );
  }),
);
