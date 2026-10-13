/** Authenticated whole-turn card Undo/Redo transport. */

import type { ReversalOutcome } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import { z } from "zod";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";
import {
  combineWorkReversalOutcome,
  reverseWorkReceipts,
} from "../../../../../lib/work-receipt-reversal.js";

const reverseBodySchema = z.strictObject({
  direction: z.enum(["undo", "redo"], { error: "direction must be undo or redo" }),
  scope: z.literal("turn"),
  target: z.string({ error: "target must be a string" }).min(1),
});

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const rawBody = await readBody(event);
  const normalizedBody =
    rawBody !== null && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {};
  const parsed = reverseBodySchema.safeParse(normalizedBody);
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: parsed.error.issues[0]?.message });
  }
  const body = parsed.data;
  const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId") as ThreadId;
  const turnId = requireRequestId(body.target, "target") as TurnId;
  const outcome = await app.documentSync.reverseThreadContext({
    threadId,
    userId: user.userId,
    direction: body.direction,
    turnId,
  });
  const canReverseWorkReceipts =
    outcome.status === "reversed" ||
    outcome.status === "reconciled" ||
    outcome.status === "nothing_to_undo" ||
    outcome.status === "nothing_to_redo" ||
    outcome.status === "partial" ||
    outcome.status === "partial_failure";
  let workReceipts = [];
  try {
    workReceipts = canReverseWorkReceipts
      ? await reverseWorkReceipts(
          {
            blocks: app.threadRepos.blocks,
            turns: app.threadRepos.turns,
            threads: app.threadRepos.threads,
            works: app.works,
            workContextNotices: app.workContextNotices,
            stopThreadRun: app.stopThreadRun,
            transaction: app.threadRepos.transaction,
          },
          { threadId, turnId, direction: body.direction },
        )
      : [];
  } catch {
    setResponseStatus(event, 200);
    return {
      ...outcome,
      status: "partial_failure",
      workError: "execution_failed",
    } satisfies ReversalOutcome;
  }
  setResponseStatus(event, 200);
  return combineWorkReversalOutcome(outcome, workReceipts, body.direction);
});
