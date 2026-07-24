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
import { getApp } from "../../../../../lib/app.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";

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
  const { user } = await requireAppUser(event);
  const rawBody = await readBody(event);
  const normalizedBody =
    rawBody !== null && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {};
  const parsed = reverseBodySchema.safeParse(normalizedBody);
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: parsed.error.issues[0]?.message });
  }
  const body = parsed.data;
  try {
    const outcome = await (await getApp()).documentSync.reverseThreadContext({
      threadId: (getRouterParam(event, "threadId") ?? "") as ThreadId,
      userId: user.userId,
      ...(body.uri ? { uri: body.uri } : {}),
      direction: body.direction,
      scope: body.scope,
      ...(body.target !== undefined ? { selection: body.target } : {}),
      turnId: (body.target ?? "") as TurnId,
    });
    setResponseStatus(event, 200);
    return outcome;
  } catch (error) {
    if (!(error instanceof ReverseThreadContextError)) throw error;
    throw createError({
      statusCode: error.code === "document_not_found" ? 404 : 400,
      message: error.message,
    });
  }
});
