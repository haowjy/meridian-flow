/**
 * Whether the Editor's initially-absent Work selection must wait rather than
 * resolve. The Editor may seed that Work from the writer's current chat once,
 * which needs the thread list. Waiting is only useful when there IS a current
 * chat to look up: with none, there is nothing to seed from, so a slow or
 * broken thread list must never block the Editor from resolving to No Work.
 */
export function editorDefaultWorkPending(params: {
  /** The Work catalog itself must be ready before anything can resolve. */
  workCatalogReady: boolean;
  /** The writer's current chat, if any (the source of the seed). */
  chatThreadId: string | null;
  /** The current chat was found in a loaded thread list. */
  displayedChatFound: boolean;
  /** The thread list query has failed. */
  threadsFailed: boolean;
  /** The thread list query has not produced any result yet. */
  threadsUnloaded: boolean;
}): boolean {
  if (!params.workCatalogReady) return true;
  return (
    params.chatThreadId !== null &&
    !params.displayedChatFound &&
    (params.threadsFailed || params.threadsUnloaded)
  );
}
