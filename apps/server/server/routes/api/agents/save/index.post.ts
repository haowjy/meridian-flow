import { saveAgentsRequestSchema } from "@meridian/contracts/agents";
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const parsed = saveAgentsRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "Invalid save request" });
  const { projectId, packages } = parsed.data;
  if (projectId) await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  const outcomes = await app.agentCatalog.savePackages(user.userId, { projectId, packages });
  return serializeTransport({ outcomes });
});
