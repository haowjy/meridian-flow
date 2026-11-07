/** Current-state preview and stateless native browser export downloads. */
import type { ProjectExportOptions, ProjectExportPreview } from "@meridian/contracts";
import { apiProjectPath } from "@meridian/contracts/protocol";
import { getJson } from "./http-client";
export function projectExportUrl(
  projectId: string,
  options: ProjectExportOptions,
  preview = false,
) {
  const query = new URLSearchParams({
    scratch: options.scratch ? "1" : "0",
    uploads: options.uploads ? "1" : "0",
  });
  return `${apiProjectPath(projectId)}/${preview ? "export/preview" : "export.zip"}?${query}`;
}
export function previewProjectExport(
  projectId: string,
  options: ProjectExportOptions,
  signal: AbortSignal,
) {
  return getJson<ProjectExportPreview>(projectExportUrl(projectId, options, true), { signal });
}
export function downloadProjectExport(url: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
