import type { ListThreadRecentDocumentsResponse } from "@meridian/contracts/protocol";
import { classifyFiletype } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireThreadOwner } from "../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

function parseLimit(raw: unknown): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
export default defineEventHandler(async (event): Promise<ListThreadRecentDocumentsResponse> => {
  const { app, user } = await requireAppUser(event);
  const threadId = getRouterParam(event, "threadId") ?? "";
  const thread = await requireThreadOwner(
    { threads: app.repos.threads, projects: app.projectRepo },
    threadId,
    user.userId,
  );
  const touches = await app.repos.documentTouches.listByThread(
    thread.id,
    parseLimit(getQuery(event).limit),
  );
  const rows = await app.uploadIdentity.lookupDocuments(touches.map((touch) => touch.documentId));
  const byId = new Map(rows.map((row) => [row.documentId, row]));
  return {
    documents: touches.flatMap((touch) => {
      const row = byId.get(touch.documentId);
      if (!row) return [];
      const classification = classifyFiletype(row.fileType);
      return [
        {
          threadId: touch.threadId,
          documentId: row.documentId,
          name: row.name,
          extension: row.extension,
          sizeBytes: row.sizeBytes,
          editable: classification.kind === "tracked",
          filetype: row.fileType,
          schemaType: classification.kind === "tracked" ? classification.schemaType : null,
          fileType:
            classification.kind === "tracked" || classification.kind === "unknown"
              ? null
              : classification.fileType,
          mimeType: row.mimeType,
          kind: classification.kind === "tracked" ? "tracked" : "binary",
          touchedAt: touch.touchedAt,
          updatedAt: row.updatedAt,
        },
      ];
    }),
  };
});
