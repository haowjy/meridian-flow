/** POST /api/account/recent-documents: records that the authenticated writer opened a document. */
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
  try {
    await app.recentDocuments.record(user.userId, documentId as DocumentId);
  } catch (error) {
    // Missing, soft-deleted, and not-owned are one 404. Do not sniff postgres codes.
    if (error instanceof RecentDocumentUnavailableError) {
      throw createError({ statusCode: 404, message: "Document not found" });
    }
    throw error;
  }
  return serializeTransport({});
});
