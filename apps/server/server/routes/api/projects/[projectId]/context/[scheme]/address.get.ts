/** Private owner-only browser bookmark resolution. Never emit permanent redirects. */
import type { ProjectId } from "@meridian/contracts";
import { defineEventHandler, getQuery } from "nitro/h3";
import { parseContextMutationPath } from "../../../../../../lib/context-mutation-validation.js";
import { resolveContextRoute } from "./_helpers.js";

export default defineEventHandler(async (event) => {
  const { app, projectId, userId, scheme, workId } = await resolveContextRoute(event);
  const path = parseContextMutationPath(getQuery(event).path, "path");
  return app.documentAddresses.resolve({
    projectId: projectId as ProjectId,
    userId,
    scheme,
    workId,
    path,
  });
});
