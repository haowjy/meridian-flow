/** PUT /api/projects/[projectId]/working-set: validates and replaces the authenticated writer's snapshot. */
import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import {
  handlePutWorkingSetRequest,
  parsePutWorkingSetRequest,
} from "../../../../lib/working-set-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const response = await handlePutWorkingSetRequest(
    {
      projectRepo: app.projectRepo,
      workingSet: app.workingSet,
      works: app.works,
      threads: app.repos.threads,
    },
    {
      projectId: getRouterParam(event, "projectId") ?? "",
      userId: user.userId,
      body: parsePutWorkingSetRequest(await readBody(event)),
    },
  );
  return serializeTransport(response);
});
