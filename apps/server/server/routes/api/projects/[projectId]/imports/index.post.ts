/** Plan or resume a selected folder/files manifest. */
import { defineEventHandler, readBody } from "nitro/h3";
import { resolveImportRoute } from "../../../../../lib/import-route.js";
export default defineEventHandler(async (event) => {
  const route = await resolveImportRoute(event),
    manifest = await readBody(event);
  return route.write(() => route.service.plan(route.projectId, route.userId, manifest));
});
