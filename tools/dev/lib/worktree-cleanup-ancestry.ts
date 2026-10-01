// Selects the Git ref used to prove targeted worktree cleanup ancestry.
export function resolveAncestryRef(
  baseBranch: string,
  refExists: (ref: string) => boolean,
): string {
  const remoteTrackingRef = `origin/${baseBranch}`;
  return refExists(remoteTrackingRef) ? remoteTrackingRef : baseBranch;
}
