/** HTTP edge for one Copy: many sources, one destination, one receipt. */

import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { handleContextCopyRequest } from "../../../../../lib/context-copy-route.js";
import { withDurableIntentInterruptBoundary } from "../../../../../shared/interrupt-boundary.js";

export default defineEventHandler((event) =>
  withDurableIntentInterruptBoundary(async () => {
    const { app, user } = await requireAppUser(event);
    return handleContextCopyRequest(
      {
        fileAccess: app.fileAccess,
        projectRepo: app.projectRepo,
        workRepo: app.workRepo,
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
