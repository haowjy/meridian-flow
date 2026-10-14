/** Resume the stored plan by id: finish its chunks and the automatic finish, then answer the status. */
import { defineEventHandler } from "nitro/h3";
import { resolveImportRoute } from "../../../../../../lib/import-route.js";
export default defineEventHandler(async (event) => {
  const route = await resolveImportRoute(event);
  return route.write(() => route.service.resume(route.importId(), route.projectId));
});
