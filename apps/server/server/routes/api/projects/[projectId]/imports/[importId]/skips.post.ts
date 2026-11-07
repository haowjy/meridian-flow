/** Skips during the upload phase. */
import { defineEventHandler } from "nitro/h3";
import { z } from "zod";
import { ImportError } from "../../../../../../domains/import/index.js";
import { readImportManifest } from "../../../../../../lib/import-body.js";
import { resolveImportRoute } from "../../../../../../lib/import-route.js";
export default defineEventHandler(async (event) => {
  const route = await resolveImportRoute(event);
  return route.write(async () => {
    const parsed = z
      .object({
        entries: z
          .array(
            z
              .object({
                entryId: z.number().int().nonnegative(),
                reason: z.enum(["unreadable", "not_found"]),
              })
              .strict(),
          )
          .max(10_000),
      })
      .strict()
      .safeParse(await readImportManifest(event));
    if (!parsed.success) throw new ImportError(400, "manifest_invalid");
    return route.service.skips(route.importId(), route.projectId, parsed.data);
  });
});
