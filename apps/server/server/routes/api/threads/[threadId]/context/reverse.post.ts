/** Authenticated reversal command transport for thread context. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import { z } from "zod";
import { ReverseThreadContextError } from "../../../../../domains/collab/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";
import {
  combineWorkReversalOutcome,
  reverseWorkReceipts,
} from "../../../../../lib/work-receipt-reversal.js";

const reverseBodySchema = z.object({
  uri: z
    .string({ error: "uri must be a non-empty string" })
    .min(1, "uri must be a non-empty string")
    .optional(),
  direction: z.enum(["undo", "redo"], { error: "direction must be undo or redo" }),
  scope: z.enum(["write", "turn", "thread"], { error: "scope must be write, turn, or thread" }),
  target: z.string({ error: "target must be a string" }).optional(),
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
  try {
    const threadId = requireRequestId(getRouterParam(event, "threadId"), "threadId") as ThreadId;
    const turnId = (body.target ?? "") as TurnId;
    const outcome = await app.documentSync.reverseThreadContext({
      threadId,
      userId: user.userId,
      ...(body.uri ? { uri: body.uri } : {}),
      direction: body.direction,
      scope: body.scope,
      ...(body.target !== undefined ? { selection: body.target } : {}),
      turnId,
    });
    const canReverseWorkReceipts =
      body.target !== undefined &&
      body.direction === "undo" &&
      (outcome.status === "reversed" ||
        outcome.status === "reconciled" ||
        outcome.status === "nothing_to_undo");
    const workReceipts = canReverseWorkReceipts
      ? await reverseWorkReceipts(
          {
            blocks: app.threadRepos.blocks,
            turns: app.threadRepos.turns,
            works: app.works,
            contextUpdates: app.systemUpdates,
          },
          { threadId, turnId, direction: body.direction },
        )
      : [];
    setResponseStatus(event, 200);
    return combineWorkReversalOutcome(outcome, workReceipts);
  } catch (error) {
    if (!(error instanceof ReverseThreadContextError)) throw error;
    throw createError({
      statusCode: error.code === "document_not_found" ? 404 : 400,
      message: error.message,
    });
  }
});
