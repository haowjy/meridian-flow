/** GET /api/account/recent-documents: lists the authenticated writer's recently opened documents. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const documents = await app.recentDocuments.listByUser(user.userId);
  return serializeTransport({ documents });
});
