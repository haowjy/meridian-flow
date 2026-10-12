/** Shared query validation for stateless ZIP downloads and previews. */
import { createError } from "nitro/h3";
import type { ExportOptions } from "../domains/export/domain/export-layout.js";
export function exportOptions(query: Record<string, unknown>): ExportOptions {
  for (const key of ["scratch", "uploads"]) {
    if (query[key] !== undefined && query[key] !== "0" && query[key] !== "1")
      throw createError({ statusCode: 400, message: "scratch and uploads must be 0 or 1" });
  }
  return { scratch: query.scratch === "1", uploads: query.uploads === "1" };
}
