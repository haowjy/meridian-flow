/** GET /api/agents/builtin?path=: a built-in Agent or skill file's text, which no document holds. */
import { createError, defineEventHandler, getQuery } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  const path = getQuery(event).path;
  const text = typeof path === "string" ? app.agentCatalog.builtinFile(path) : undefined;
  if (text === undefined) throw createError({ statusCode: 404, message: "No built-in file there" });
  return { text };
});
