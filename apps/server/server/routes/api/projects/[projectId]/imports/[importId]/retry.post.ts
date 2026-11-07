/** Retry a durable import. */
import { defineEventHandler } from "nitro/h3";
import { resolveImportRoute } from "../../../../../../lib/import-route.js";
export default defineEventHandler(async (event) => {
  const route = await resolveImportRoute(event);
  const result = await route.write(() => route.service.retry(route.importId(), route.projectId));
  return result;
});
