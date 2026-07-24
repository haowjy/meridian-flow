import type { AuthMeResponse } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import { requireAppUserFromRequest } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { user } = await requireAppUserFromRequest(event.req);
  return { user } satisfies AuthMeResponse;
});
