import { createError, defineEventHandler, getRequestHeader, readRawBody } from "nitro/h3";
import { getApp } from "../../../../lib/app.js";

export default defineEventHandler(async (event) => {
  const app = await getApp();
  const payload = await readRawBody(event, "utf8");
  if (!payload) throw createError({ statusCode: 400, message: "Webhook payload is required" });
  try {
    return await app.billing.handleWebhook({
      payload,
      signature: getRequestHeader(event, "stripe-signature") ?? null,
    });
  } catch (error) {
    throw createError({
      statusCode: 400,
      message: error instanceof Error ? error.message : "Invalid billing webhook",
    });
  }
});
