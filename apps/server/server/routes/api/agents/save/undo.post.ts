import { undoSaveRequestSchema } from "@meridian/contracts/agents";
import { serializeTransport } from "@meridian/contracts/protocol";
import { createError, defineEventHandler, readBody } from "nitro/h3";
import { requireProjectOwner } from "../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const parsed = undoSaveRequestSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "Invalid undo request" });
  const { projectId, ...rest } = parsed.data;
  if (projectId) await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  return serializeTransport(await app.agentCatalog.undoSave(user.userId, { projectId, ...rest }));
});
