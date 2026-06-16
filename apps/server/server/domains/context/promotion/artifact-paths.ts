export function parentSourcePath(sourcePath: string): string {
  const normalized = sourcePath.replace(/^\/+|\/+$/g, "");
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "." : normalized.slice(0, idx);
}

/** Maps a source path to a work-scoped results URI under the promoting Work. */
export function resultsUriForSourcePath(
  workId: string,
  rootThreadId: string,
  sourcePath: string,
): string {
  const normalized = sourcePath.replace(/^\/+/, "");
  const runPrefix = `runs/${rootThreadId}/`;
  const relative = normalized.startsWith(runPrefix)
    ? normalized.slice(runPrefix.length)
    : normalized;
  return `work://${workId}/results/${relative}`;
}

export function objectStoreKeyForResult(
  projectId: string,
  rootThreadId: string,
  resultId: string,
  sourcePath: string,
): string {
  const baseName = sourcePath.replace(/^\/+/, "").split("/").pop() ?? "artifact";
  return `results/${projectId}/${rootThreadId}/${resultId}/${baseName}`;
}
