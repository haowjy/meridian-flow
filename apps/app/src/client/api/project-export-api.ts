/** Counted export preparation, followed by a native streamed browser download. */
import type { ProjectExportOptions, ProjectExportStart } from "@meridian/contracts";
import { apiProjectPath } from "@meridian/contracts/protocol";
import { postJson } from "./http-client";
export function startProjectExport(
  projectId: string,
  options: ProjectExportOptions,
  signal?: AbortSignal,
) {
  return postJson<ProjectExportStart>(`${apiProjectPath(projectId)}/exports`, options, { signal });
}
export function downloadProjectExport(url: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
