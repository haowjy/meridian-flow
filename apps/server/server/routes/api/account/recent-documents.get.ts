/** GET /api/account/recent-documents: lists the authenticated writer's recently opened documents. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery } from "nitro/h3";
import { USER_RECENT_DOCUMENTS_CAP } from "../../../domains/recent-documents/index.js";
import { requireAppUser } from "../../../lib/auth-gate.js";

function parseLimit(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return USER_RECENT_DOCUMENTS_CAP;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return USER_RECENT_DOCUMENTS_CAP;
  return Math.min(parsed, USER_RECENT_DOCUMENTS_CAP);
}

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const documents = await app.recentDocuments.listByUser(
    user.userId,
    parseLimit(getQuery(event).limit),
  );
  return serializeTransport({ documents });
});
