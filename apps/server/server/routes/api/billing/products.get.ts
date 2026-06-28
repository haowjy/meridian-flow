import { defineEventHandler } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { billingProducts, createBillingRouteDeps } from "../../../lib/billing-route.js";

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  return billingProducts(createBillingRouteDeps(app, process.env));
});
