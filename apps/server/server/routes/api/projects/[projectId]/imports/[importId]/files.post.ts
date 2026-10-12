/** Batched multipart landing; the import domain bounds parts, bytes and concurrency. */
import { defineEventHandler } from "nitro/h3";
import { readImportParts } from "../../../../../../lib/import-body.js";
import { resolveImportRoute } from "../../../../../../lib/import-route.js";
export default defineEventHandler(async (event) => {
  const route = await resolveImportRoute(event);
  return route.write(() =>
    route.service.receive(route.importId(), route.projectId, () => readImportParts(event)),
  );
});
