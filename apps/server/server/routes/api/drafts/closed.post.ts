/** POST /api/drafts/closed: which of the drafts a browser holds copies of the server has closed. */
import { CLOSED_DRAFTS_MAX, type ClosedDraftsResponse } from "@meridian/contracts/branches";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { z } from "zod";
import { requireAppUser } from "../../../lib/auth-gate.js";

const request = z.strictObject({
  draftIds: z.array(z.string().min(1).max(128)).max(CLOSED_DRAFTS_MAX),
});

export default defineEventHandler(async (event): Promise<ClosedDraftsResponse> => {
  const { app, user } = await requireAppUser(event);
  const parsed = request.safeParse(await readBody(event));
  if (!parsed.success)
    throw createError({ statusCode: 400, message: "Invalid closed-drafts request" });
  return {
    closed: await app.documentSync.closedDrafts(user.userId, parsed.data.draftIds),
  };
});
