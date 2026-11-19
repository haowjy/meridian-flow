/** POST /api/drafts/states: which of the drafts a browser holds copies of still exist. */
import { DRAFT_STATES_MAX, type DraftStatesResponse } from "@meridian/contracts/branches";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { z } from "zod";
import { requireAppUser } from "../../../lib/auth-gate.js";

const request = z.strictObject({
  draftIds: z.array(z.string().min(1).max(128)).max(DRAFT_STATES_MAX),
});

export default defineEventHandler(async (event): Promise<DraftStatesResponse> => {
  const { app, user } = await requireAppUser(event);
  const parsed = request.safeParse(await readBody(event));
  if (!parsed.success)
    throw createError({ statusCode: 400, message: "Invalid draft states request" });
  return { open: await app.documentSync.openDraftIds(user.userId, parsed.data.draftIds) };
});
