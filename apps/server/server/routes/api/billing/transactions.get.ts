import { defineEventHandler, getQuery } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const query = getQuery(event);
  const limit = query.limit ? Number(query.limit) : undefined;
  return app.billing.transactions({ userId: user.userId, limit });
});
