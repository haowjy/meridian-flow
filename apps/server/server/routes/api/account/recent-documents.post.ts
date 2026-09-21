/** POST /api/account/recent-documents: records that the authenticated writer opened a document. */
import type { DocumentId } from "@meridian/contracts";
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
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
    // A just-created document's row can lag the open by a beat, and a deleted
    // document's row is gone. Answer 404 so the fire-and-forget caller retries a
    // fresh miss instead of dropping the write; anything else is a real fault.
    if ((error as { code?: string }).code === "23503") {
      throw createError({ statusCode: 404, message: "Document not found" });
    }
    throw error;
  }
  return serializeTransport({});
});
