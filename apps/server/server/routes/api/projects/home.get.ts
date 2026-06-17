/** GET /api/projects/home: resolves the authenticated user's landing project. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { handleGetHomeProjectRequest } from "../../../lib/home-project-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const result = await handleGetHomeProjectRequest(
    {
      users: app.users,
      projects: app.projects,
      projectRepo: app.projectRepo,
    },
    user.userId,
  );
  return serializeTransport(result);
});
