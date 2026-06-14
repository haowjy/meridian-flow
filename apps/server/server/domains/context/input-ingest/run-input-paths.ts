export function runScopedInputPath(rootThreadId: string, relativePath: string): string {
  const normalized = relativePath.replace(/^\/+/, "");
  if (!normalized || normalized.includes(".."))
    throw new Error(`Invalid run input relative path: ${relativePath}`);
  return `runs/${rootThreadId}/input/${normalized}`;
}
export function parentSourcePath(remotePath: string): string {
  const index = remotePath.lastIndexOf("/");
  return index === -1 ? "." : remotePath.slice(0, index);
}
