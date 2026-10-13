/** Display identity for a hunk without an owning operation; never a command target. */
const UNATTRIBUTED_PREFIX = "unattributed:";
export function unattributedHunkKey(hunkId: string): string {
  return `${UNATTRIBUTED_PREFIX}${hunkId}`;
}
