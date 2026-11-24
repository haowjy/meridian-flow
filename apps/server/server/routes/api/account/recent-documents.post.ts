import type { DocumentId } from "@meridian/contracts";
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { RecentDocumentUnavailableError } from "../../../domains/recent-documents/index.js";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { requireRequestId } from "../../../lib/request-id.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const raw = await readBody(event);
  if (!raw || typeof raw !== "object") {
    throw createError({ statusCode: 400, message: "Request body must be an object" });
  }
  const documentId = requireRequestId((raw as { documentId?: unknown }).documentId, "documentId");
  let recorded = false;
  try {
    recorded = await app.recentDocuments.record(user.userId, documentId as DocumentId);
  } catch (error) {
    if (error instanceof RecentDocumentUnavailableError) {
      throw createError({ statusCode: 404, message: "Document not found" });
    }
    throw error;
  }
  return serializeTransport({ recorded });
});
