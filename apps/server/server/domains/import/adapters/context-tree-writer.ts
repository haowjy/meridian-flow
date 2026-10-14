/** Destination resolution for upload admission. Organize owns all Context writes. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ContextParentLocations, ProjectContextFsScheme } from "../../context/index.js";
import { ImportError } from "../domain/manifest.js";
import type { ImportDestination } from "../ports/import-tree-writer.js";
export const IMPORT_AREAS = [
  "manuscript",
  "kb",
  "unfiled",
] as const satisfies readonly ProjectContextFsScheme[];
export function createContextImportTreeWriter(
  locations: ContextParentLocations,
): ImportDestination {
  return {
    async destination(uri) {
      const parsed = parseContextUri(uri);
      if (
        !parsed.ok ||
        !parsed.value ||
        !(IMPORT_AREAS as readonly string[]).includes(parsed.value.scheme)
      )
        throw new ImportError(400, "destination_invalid");
      const { scheme, path } = parsed.value;
      const segments = path.split("/").filter(Boolean);
      // An area's root is a valid destination even before its source exists.
      if (!segments.length) return { folderId: null };
      const found = await locations.findFolder(scheme as (typeof IMPORT_AREAS)[number], segments);
      if (!found) throw new ImportError(404, "destination_not_found");
      return found;
    },
  };
}
