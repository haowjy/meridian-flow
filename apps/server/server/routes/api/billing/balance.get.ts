import { defineEventHandler } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { billingBalance, createBillingRouteDeps } from "../../../lib/billing-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectId } = await app.projects.ensureDefaultBootstrap(user.userId);
  return billingBalance(createBillingRouteDeps(app, process.env), {
    userId: user.userId,
    projectId,
  });
});
