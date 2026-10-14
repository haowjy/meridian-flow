/** A consistent full status or changed entries after a decimal version. */
import { createError, defineEventHandler, getQuery } from "nitro/h3";
import { resolveImportRoute } from "../../../../../../lib/import-route.js";
export default defineEventHandler(async (event) => {
  const route = await resolveImportRoute(event),
    since = getQuery(event).since;
  if (
    since !== undefined &&
    (typeof since !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(since) ||
      since.length > 19 ||
      BigInt(since) > 9223372036854775807n)
  )
    throw createError({ statusCode: 400, message: "invalid_import_version" });
  return route.read(() =>
    typeof since === "string"
      ? route.service.status(route.importId(), route.projectId, since)
      : route.service.status(route.importId(), route.projectId),
  );
});
