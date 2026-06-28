import type { CreateCheckoutSessionRequest } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import {
  createBillingCheckoutSession,
  createBillingRouteDeps,
} from "../../../../lib/billing-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = await readBody<CreateCheckoutSessionRequest>(event);
  if (!body?.entryId || !body.successUrl || !body.cancelUrl) {
    throw createError({
      statusCode: 400,
      message: "entryId, successUrl, and cancelUrl are required",
    });
  }
  return createBillingCheckoutSession(createBillingRouteDeps(app, process.env), {
    userId: user.userId,
    body,
  });
});
