/** Project ZIP download, kept native so the browser streams it to disk. */
import { apiProjectPath } from "@meridian/contracts/protocol";
export function downloadProjectExport(
  projectId: string,
  options: { scratch: boolean; uploads: boolean },
) {
  const query = new URLSearchParams();
  if (options.scratch) query.set("scratch", "1");
  if (options.uploads) query.set("uploads", "1");
  const anchor = document.createElement("a");
  anchor.href = `${apiProjectPath(projectId)}/export.zip?${query}`;
  anchor.download = "";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
