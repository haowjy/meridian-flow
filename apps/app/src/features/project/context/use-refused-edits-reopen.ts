/** Editor hosts' reopen after the server refused a live room's pending edits. */
import { useEffect, useReducer, useRef } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import { useLiveDocumentSessionRegistry } from "./account-feature-context";

/** Refused sessions whose drop has finished, whether or not it removed them. */
const settledDrops = new WeakSet<DocumentSession>();

/**
 * The session registry drops a live room whose pending edits the server
 * refused (4409) and clears its local copy. The host unbinds its editor at
 * once, before that Y.Doc is torn down, and reopens once the drop has
 * finished, so the editor loads the server's state. Returns the session the
 * host may bind: `null` while a refused session is being dropped. A session
 * the drop couldn't remove binds again, read-only, instead of reopening again.
 */
export function useRefusedEditsReopen(
  session: DocumentSession | null,
  reopen: () => void,
): DocumentSession | null {
  const registry = useLiveDocumentSessionRegistry();
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  const reopenRef = useRef(reopen);
  reopenRef.current = reopen;
  useEffect(() => {
    if (!session || settledDrops.has(session)) return;
    let active = true;
    let started = false;
    const unsubscribe = session.subscribe(() => {
      if (started || !session.refusedLocalEdits()) return;
      started = true;
      rerender();
      void registry.dropRefusedRoom(session).then(() => {
        settledDrops.add(session);
        if (!active) return;
        rerender();
        reopenRef.current();
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [registry, session]);
  if (
    !session ||
    session.getSnapshot().status === "destroyed" ||
    (session.refusedLocalEdits() && !settledDrops.has(session))
  )
    return null;
  return session;
}
