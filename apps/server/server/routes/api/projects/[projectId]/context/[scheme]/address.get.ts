/** Private owner-only browser bookmark resolution. Never emit permanent redirects. */
import type { ProjectId } from "@meridian/contracts";
import { defineEventHandler, getQuery } from "nitro/h3";
import { parseContextMutationPath } from "../../../../../../lib/context-mutation-validation.js";
import { handleDocumentAddressRequest } from "../../../../../../lib/document-address-route.js";
import { resolveContextRoute } from "./_helpers.js";

export default defineEventHandler(async (event) => {
  const { app, projectId, userId, scheme, workId } = await resolveContextRoute(event);
  const query = getQuery(event);
  const path = parseContextMutationPath(query.path, "path");
  const hasReview = query.reviewWorkId !== undefined || query.draftBranchId !== undefined;
  if (
    hasReview &&
    (typeof query.reviewWorkId !== "string" ||
      !query.reviewWorkId ||
      typeof query.draftBranchId !== "string" ||
      !query.draftBranchId ||
      (query.documentId !== undefined && typeof query.documentId !== "string"))
  )
    return { kind: "unavailable" } as const;
  return handleDocumentAddressRequest(
    {
      documentAddresses: app.documentAddresses,
      workRepo: app.workRepo,
      draftReview: app.documentSync.draftReview,
      fileAccess: app.fileAccess,
    },
    {
      projectId: projectId as ProjectId,
      userId,
      scheme,
      workId,
      rootThreadId: typeof query.rootThreadId === "string" ? query.rootThreadId : null,
      path,
    },
    hasReview
      ? {
          workId: query.reviewWorkId as string,
          draftBranchId: query.draftBranchId as string,
          ...(typeof query.documentId === "string" ? { documentId: query.documentId } : {}),
        }
      : undefined,
  );
});
