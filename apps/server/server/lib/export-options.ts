/** Shared query validation for stateless ZIP downloads and previews. */

import type { ProjectExportOptions } from "@meridian/contracts";
import { createError } from "nitro/h3";
export function exportOptions(query: Record<string, unknown>): ProjectExportOptions {
  for (const key of ["scratch", "uploads"]) {
    if (query[key] !== undefined && query[key] !== "0" && query[key] !== "1")
      throw createError({ statusCode: 400, message: "scratch and uploads must be 0 or 1" });
  }
  return { scratch: query.scratch === "1", uploads: query.uploads === "1" };
}
