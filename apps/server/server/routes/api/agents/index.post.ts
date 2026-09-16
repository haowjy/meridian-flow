/** POST /api/agents: publish standalone Mars source to the authenticated account's catalog. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { z } from "zod";
import {
  AgentConfigurationError,
  AgentPublicationConflictError,
  AgentSourceError,
} from "../../../domains/packages/index.js";
import { requireAppUser } from "../../../lib/auth-gate.js";

const input = z.strictObject({
  slug: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  content: z.string(),
  expectedRevisionId: z.uuid().optional(),
});

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const parsed = input.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: parsed.error.message });
  try {
    return serializeTransport(await app.agentCatalog.save(user.userId, parsed.data));
  } catch (error) {
    if (error instanceof AgentPublicationConflictError)
      throw createError({ statusCode: 409, message: error.message });
    if (error instanceof AgentConfigurationError || error instanceof AgentSourceError)
      throw createError({ statusCode: 422, message: error.message });
    throw error;
  }
});
