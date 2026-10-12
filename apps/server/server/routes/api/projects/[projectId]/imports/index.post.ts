/** Plan or resume a selected folder/files manifest. */
import { defineEventHandler } from "nitro/h3";
import { readImportManifest } from "../../../../../lib/import-body.js";
import { resolveImportRoute } from "../../../../../lib/import-route.js";
export default defineEventHandler(async (event) => {
  const route = await resolveImportRoute(event);
  return route.write(async () =>
    route.service.plan(route.projectId, route.userId, await readImportManifest(event)),
  );
});
