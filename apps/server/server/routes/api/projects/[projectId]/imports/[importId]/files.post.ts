/** Batched multipart landing; request and attempt heartbeats keep long transfers live. */
import { createError, defineEventHandler, readMultipartFormData } from "nitro/h3";
import { resolveImportRoute } from "../../../../../../lib/import-route.js";
export default defineEventHandler(async (event) => {
  const route = await resolveImportRoute(event);
  return route.write(async () => {
    const parts = await route.service.receiving(route.importId(), route.projectId, () =>
      readMultipartFormData(event),
    );
    if (
      !parts?.length ||
      parts.some((part) => !part.filename || !/^(0|[1-9][0-9]*)$/.test(part.name ?? ""))
    )
      throw createError({ statusCode: 400, message: "invalid_import_file_parts" });
    if (new Set(parts.map((part) => part.name)).size !== parts.length)
      throw createError({ statusCode: 400, message: "duplicate_import_entry_id" });
    const total = parts.reduce((sum, part) => sum + part.data.length, 0);
    if (total > 50 * 1024 * 1024 || (parts.length > 1 && total > 8 * 1024 * 1024))
      throw createError({ statusCode: 413, message: "import_request_too_large" });
    return {
      entries: await Promise.all(
        parts.map((part) =>
          route.service.land(route.projectId, route.importId(), Number(part.name), part.data),
        ),
      ),
    };
  });
});
