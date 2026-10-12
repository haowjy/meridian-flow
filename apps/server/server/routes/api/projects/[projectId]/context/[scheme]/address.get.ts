/** Private owner-only browser bookmark resolution. Never emit permanent redirects. */
import type { ProjectId } from "@meridian/contracts";
import type { UserId } from "@meridian/contracts/runtime";
import { defineEventHandler, getQuery } from "nitro/h3";
import { isFileAccessDenied } from "../../../../../../domains/file-policy/index.js";
import { parseContextMutationPath } from "../../../../../../lib/context-mutation-validation.js";
import { resolveContextRoute } from "./_helpers.js";

export default defineEventHandler(async (event) => {
  const { app, projectId, userId, scheme, workId } = await resolveContextRoute(event);
  const path = parseContextMutationPath(getQuery(event).path, "path");
  const resolved = await app.documentAddresses.resolve({
    projectId: projectId as ProjectId,
    userId,
    scheme,
    workId,
    rootThreadId:
      typeof getQuery(event).rootThreadId === "string"
        ? (getQuery(event).rootThreadId as string)
        : null,
    path,
  });
  if (resolved.kind === "unavailable") return resolved;
  // The final identity after alias resolution must be readable (file-access §4).
  const grant = await app.fileAccess.authorize(
    { accountId: userId as UserId },
    { kind: "document", documentId: resolved.document.documentId },
    "read",
  );
  return isFileAccessDenied(grant) ? ({ kind: "unavailable" } as const) : resolved;
});
