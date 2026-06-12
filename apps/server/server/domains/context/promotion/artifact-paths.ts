export function parentSourcePath(sourcePath: string): string {
  const normalized = sourcePath.replace(/^\/+|\/+$/g, "");
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "." : normalized.slice(0, idx);
}

export function resultsUriForSourcePath(rootThreadId: string, sourcePath: string): string {
  const normalized = sourcePath.replace(/^\/+/, "");
  const runPrefix = `runs/${rootThreadId}/`;
  const relative = normalized.startsWith(runPrefix)
    ? normalized.slice(runPrefix.length)
    : normalized;
  return `work://.results/${relative}`;
}

export function objectStoreKeyForResult(
  workbenchId: string,
  rootThreadId: string,
  resultId: string,
  sourcePath: string,
): string {
  const baseName = sourcePath.replace(/^\/+/, "").split("/").pop() ?? "artifact";
  return `results/${workbenchId}/${rootThreadId}/${resultId}/${baseName}`;
}
