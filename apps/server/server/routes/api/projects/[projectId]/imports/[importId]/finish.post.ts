/** Stop here; the import-row exclusive fence makes Finish terminal. */
import { defineEventHandler } from "nitro/h3";
import { resolveImportRoute } from "../../../../../../lib/import-route.js";
export default defineEventHandler(async (event) => {
  const route = await resolveImportRoute(event);
  return route.write(() => route.service.finish(route.importId(), route.projectId));
});
