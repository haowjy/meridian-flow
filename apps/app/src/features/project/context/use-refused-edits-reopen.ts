/** Editor hosts' reopen after the server refused a live room's pending edits. */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import { useLiveDocumentSessionRegistry } from "./account-feature-context";

const unsubscribed = () => undefined;

/**
 * The session registry drops a live room whose pending edits the server
 * refused (4409) and clears its local copy. The host unbinds its editor at
 * once, before that Y.Doc is torn down, and reopens once the drop has
 * finished, so the editor loads the server's state. Returns the session the
 * host may bind: `null` while a refused session is being dropped. A session
 * the drop couldn't remove binds again, read-only: its drop has settled.
 */
export function useRefusedEditsReopen(
  session: DocumentSession | null,
  reopen: () => void,
): DocumentSession | null {
  const registry = useLiveDocumentSessionRegistry();
  const reopenRef = useRef(reopen);
  reopenRef.current = reopen;
  // The registry hears every change before a host can, so its drop is the
  // snapshot here: the same promise for as long as it runs.
  const drop = useSyncExternalStore(
    useCallback((onChange: () => void) => session?.subscribe(onChange) ?? unsubscribed, [session]),
    () => (session ? registry.whenRefusedRoomDropped(session) : null),
  );
  useEffect(() => {
    if (!drop) return;
    let active = true;
    void drop.then(() => {
      if (active) reopenRef.current();
    });
    return () => {
      active = false;
    };
  }, [drop]);
  if (!session || drop || session.getSnapshot().status === "destroyed") return null;
  return session;
}
