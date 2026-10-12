import type { ThreadId } from "@meridian/contracts/runtime";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { requireThreadOwner } from "../../../../../domains/threads/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";
import { getWorkReceiptReversalAvailability } from "../../../../../lib/work-receipt-reversal.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId") as ThreadId;
  const { target } = getQuery(event);
  if (typeof target === "string" && target.length > 0) {
    await requireThreadOwner({ threads: app.threadRepos.threads }, threadId, user.userId);
    return getWorkReceiptReversalAvailability(
      {
        blocks: app.threadRepos.blocks,
        turns: app.threadRepos.turns,
        works: app.workRepo,
        threads: app.threadRepos.threads,
      },
      { threadId, turnId: requireRequestId(target, "target") },
    );
  }
  throw createError({ statusCode: 400, message: "target is required" });
});
