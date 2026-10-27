/** Acknowledge a durable import. */
import { defineEventHandler } from "nitro/h3";
import { resolveImportRoute } from "../../../../../../lib/import-route.js";
export default defineEventHandler(async (event) => {
  const route = await resolveImportRoute(event);
  await route.write(() => route.service.acknowledge(route.importId(), route.projectId));
  return new Response(null, { status: 204 });
});
