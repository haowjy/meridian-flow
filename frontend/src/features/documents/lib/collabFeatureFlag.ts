/** Whether collab (Yjs sync) is active for a given file extension. */
export function isCollabEnabled(extension: string): boolean {
  const normalized = extension.toLowerCase();
  return (
    normalized === ".md" ||
    normalized === ".markdown" ||
    normalized === ".txt"
  );
}
