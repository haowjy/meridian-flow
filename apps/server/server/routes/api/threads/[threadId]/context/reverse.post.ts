/** Authenticated whole-turn card Undo/Redo transport. */

import {
  DOCUMENT_COMMAND_CONFLICT_CODE,
  DocumentCommandIdSchema,
} from "@meridian/contracts/branches";
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
import { DocumentCommandConflictError } from "../../../../../domains/collab/domain/document-commands.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { requireRequestId } from "../../../../../lib/request-id.js";
import { reverseTurnCard } from "../../../../../lib/work-receipt-reversal.js";
import { throwHttpInterrupt } from "../../../../../shared/interrupt-boundary.js";

const reverseBodySchema = z.strictObject({
  direction: z.enum(["undo", "redo"], { error: "direction must be undo or redo" }),
  scope: z.literal("turn"),
  commandId: DocumentCommandIdSchema,
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
    if (!(cause instanceof DocumentCommandConflictError)) throw cause;
    return throwHttpInterrupt(
      meridianErrorFromSystem(
        DOCUMENT_COMMAND_CONFLICT_CODE,
        "That command id was used for a different command",
        false,
      ),
      409,
    );
  }
});
