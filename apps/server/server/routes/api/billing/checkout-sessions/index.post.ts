import type { CreateCheckoutSessionRequest } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { BillingRequestError } from "../../../../domains/billing/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = await readBody<CreateCheckoutSessionRequest>(event);
  if (!body?.entryId || !body.successUrl || !body.cancelUrl) {
    throw createError({
      statusCode: 400,
      message: "entryId, successUrl, and cancelUrl are required",
    });
  }
  try {
    return await app.billing.createCheckoutSession({ userId: user.userId, body });
  } catch (error) {
    if (error instanceof BillingRequestError) {
      throw createError({ statusCode: 400, message: error.message });
    }
    throw error;
  }
});
