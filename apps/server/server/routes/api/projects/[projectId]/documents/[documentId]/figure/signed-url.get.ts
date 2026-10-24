/** Figure signed URL HTTP boundary: resolve the query view, authorize, then sign. */
import { serializeTransport } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import type { H3Event } from "nitro/h3";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireProjectOwner } from "../../../../../../../domains/projects/index.js";
import type { AppServices } from "../../../../../../../lib/app.js";
import { requireAppUser } from "../../../../../../../lib/auth-gate.js";
import { documentTarget, requireFileGrant } from "../../../../../../../lib/file-access-http.js";
import { requireRequestId } from "../../../../../../../lib/request-id.js";

type FigureSignedUrlServices = Pick<AppServices, "fileAccess" | "figureAssets"> & {
  projectRepo: Pick<AppServices["projectRepo"], "findById">;
  documentSync: Pick<AppServices["documentSync"], "branches">;
};

/** Authentication is the HTTP boundary; all query, authorization and signing logic stays shared. */
export function createFigureSignedUrlHandler(
  authenticate: (event: H3Event) => Promise<{
    app: FigureSignedUrlServices;
    user: { userId: UserId };
  }>,
) {
  return defineEventHandler(async (event) => {
    const { app, user } = await authenticate(event);
    const projectId = getRouterParam(event, "projectId") ?? "";
    const assetDocumentId = requireRequestId(getRouterParam(event, "documentId"), "documentId");
    await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
    const queryWorkId = getQuery(event).workId;
    const workId = queryWorkId === undefined ? undefined : requireRequestId(queryWorkId, "workId");
    const view = workId
      ? await app.documentSync.branches.viewForWork(workId)
      : { kind: "live" as const };
    const asset = await requireFileGrant(
      app.fileAccess,
      user.userId,
      workId
        ? { kind: "draft", documentId: assetDocumentId, workId }
        : documentTarget(assetDocumentId),
      "read",
    );
    if (asset.facts.projectId !== projectId) {
      throw createError({ statusCode: 404, message: "Document not found" });
    }
    const result = await app.figureAssets.getSignedFigureUrl({ projectId, assetDocumentId, view });
    if (!result.ok)
      throw createError({
        statusCode: result.error.code === "document_not_found" ? 404 : 502,
        message: result.error.message,
      });
    return serializeTransport(result.value);
  });
}

export default createFigureSignedUrlHandler(requireAppUser);
