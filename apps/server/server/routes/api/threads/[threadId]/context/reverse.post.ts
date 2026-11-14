/** Authenticated whole-turn card Undo/Redo transport. */

import {
  DOCUMENT_COMMAND_CONFLICT_CODE,
  DocumentCommandIdSchema,
} from "@meridian/contracts/branches";
import { meridianErrorFromSystem, type ReversalOutcome } from "@meridian/contracts/protocol";
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
import { getDb } from "../../../../../lib/db.js";
import { requireRequestId } from "../../../../../lib/request-id.js";
import {
  combineWorkReversalOutcome,
  reverseWorkReceipts,
} from "../../../../../lib/work-receipt-reversal.js";
import { runInDrizzleSavepoint } from "../../../../../shared/drizzle-transaction.js";
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
  // The Work receipts reverse in the command's transaction, after the documents, so the stored
  // outcome is the whole answer; their own savepoint keeps a Work failure from undoing the
  // documents' reversal.
  const alongside = async (outcome: ReversalOutcome): Promise<ReversalOutcome> => {
    const canReverseWorkReceipts =
      outcome.status === "reversed" ||
      outcome.status === "reconciled" ||
      outcome.status === "nothing_to_undo" ||
      outcome.status === "nothing_to_redo" ||
      outcome.status === "partial" ||
      outcome.status === "partial_failure";
    if (!canReverseWorkReceipts) return outcome;
    try {
      const workReceipts = await reverseWorkReceipts(
        {
          blocks: app.threadRepos.blocks,
          turns: app.threadRepos.turns,
          threads: app.threadRepos.threads,
          works: app.works,
          workContextNotices: app.workContextNotices,
          stopThreads: app.stopThreads,
          transaction: (operation) => runInDrizzleSavepoint(getDb(), operation),
        },
        { threadId, turnId, direction: body.direction },
      );
      return combineWorkReversalOutcome(outcome, workReceipts, body.direction);
    } catch {
      return { ...outcome, status: "partial_failure", workError: "execution_failed" };
    }
  };
  try {
    const outcome = await app.documentSync.reverseThreadContext({
      threadId,
      userId: user.userId,
      direction: body.direction,
      turnId,
      commandId: body.commandId,
      alongside,
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
