/** Continue's re-picked files whose entries are already received; hashes only, no bytes. */
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
                sha256: z.string().regex(/^[0-9a-f]{64}$/),
              })
              .strict(),
          )
          .max(10_000),
      })
      .strict()
      .safeParse(await readImportManifest(event));
    if (!parsed.success) throw new ImportError(400, "manifest_invalid");
    return route.service.picked(route.importId(), route.projectId, parsed.data);
  });
});
