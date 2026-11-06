/** HTTP edge for deleting one entry (and everything under a folder) by id. */

import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import { handleContextDeleteRequest } from "../../../../../../../lib/context-delete-route.js";
import { requireRequestId } from "../../../../../../../lib/request-id.js";
import { withDurableIntentInterruptBoundary } from "../../../../../../../shared/interrupt-boundary.js";

export default defineEventHandler((event) =>
  withDurableIntentInterruptBoundary(async () => {
    const { app, user } = await requireAppUser(event);
    return handleContextDeleteRequest(
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
