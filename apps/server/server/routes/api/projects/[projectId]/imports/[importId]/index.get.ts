/** Full selection and durable receipt progress for Continue. */
import { defineEventHandler } from "nitro/h3";
import { resolveImportRoute } from "../../../../../../lib/import-route.js";
export default defineEventHandler(async (event) => {
  const route = await resolveImportRoute(event);
  return route.read(() => route.service.detail(route.importId(), route.projectId));
});
