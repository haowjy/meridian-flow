import { defineEventHandler, getQuery } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { billingTransactions, createBillingRouteDeps } from "../../../lib/billing-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const { projectId } = await app.projects.ensureDefaultBootstrap(user.userId);
  const query = getQuery(event);
  const limit = query.limit ? Number(query.limit) : undefined;
  return billingTransactions(createBillingRouteDeps(app, process.env), {
    userId: user.userId,
    projectId,
    limit,
  });
});
