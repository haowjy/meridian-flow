import { defineEventHandler } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { billingPacksPlans, createBillingRouteDeps } from "../../../lib/billing-route.js";

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  return billingPacksPlans(createBillingRouteDeps(app, process.env));
});
