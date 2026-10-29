/** Stop upload and discard its staging prefix. */
import { defineEventHandler } from "nitro/h3";
import { resolveImportRoute } from "../../../../../../lib/import-route.js";
export default defineEventHandler(async (event) => {
  const route = await resolveImportRoute(event);
  return route.write(() => route.service.stop(route.importId(), route.projectId));
});
