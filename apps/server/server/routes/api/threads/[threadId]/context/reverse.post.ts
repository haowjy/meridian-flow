/** Authenticated whole-turn card Undo/Redo transport. */

import { COMMAND_CONFLICT_CODE, CommandIdSchema } from "@meridian/contracts/commands";
import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
  setResponseStatus,
} from "nitro/h3";
import { z } from "zod";
import { ReversalOwnersMoved } from "../../../../../domains/collab/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";
import { reverseTurnCard } from "../../../../../lib/work-receipt-reversal.js";
import { CommandConflictError } from "../../../../../shared/commands/command-record.js";
import { throwHttpInterrupt } from "../../../../../shared/interrupt-boundary.js";

const reverseBodySchema = z.strictObject({
  direction: z.enum(["undo", "redo"], { error: "direction must be undo or redo" }),
  scope: z.literal("turn"),
  commandId: CommandIdSchema,
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
  try {
    const outcome = await reverseTurnCard(app, {
      threadId,
      userId: user.userId,
      direction: body.direction,
      turnId,
      commandId: body.commandId,
    });
    setResponseStatus(event, 200);
    return outcome;
  } catch (cause) {
    // The Works kept changing under the click's locks: nothing was stored, the same request may resend.
    if (cause instanceof ReversalOwnersMoved)
      throw createError({
        statusCode: 503,
        message: cause.message,
        headers: { "Retry-After": "1" },
      });
    if (!(cause instanceof CommandConflictError)) throw cause;
    return throwHttpInterrupt(
      meridianErrorFromSystem(
        COMMAND_CONFLICT_CODE,
        "That command id was used for a different command",
        false,
      ),
      409,
    );
  }
});
