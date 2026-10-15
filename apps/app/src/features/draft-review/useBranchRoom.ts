/**
 * React's hold on a branch room: the session now backing `roomName` while a surface needs it, and a call
 * to `onUnavailable` when the room can no longer be used as named. The room itself is
 * `readBranchRoom`'s; this only mirrors it into state.
 */
import { useEffect, useRef, useState } from "react";
import { readBranchRoom } from "@/core/editor/branch-room-read";
import type { DocumentSession } from "@/core/editor/document-session";
import { useLiveDocumentSessionRegistry } from "@/features/project/context/account-feature-context";

export function useBranchRoom(
  roomName: string | null,
  onUnavailable?: () => void,
): DocumentSession | null {
  const registry = useLiveDocumentSessionRegistry();
  const [held, setHeld] = useState<{ roomName: string; session: DocumentSession } | null>(null);
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;

  useEffect(() => {
    if (!roomName) {
      setHeld(null);
      return;
    }
    const read = readBranchRoom(registry, roomName);
    const follow = () => {
      const current = read.session();
      setHeld(current && { roomName, session: current });
      if (read.unavailable()) unavailable.current?.();
    };
    const unsubscribe = read.subscribe(follow);
    follow();
    return () => {
      unsubscribe();
      read.dispose();
      setHeld(null);
    };
  }, [roomName, registry]);

  // A session of another room is never handed out, not even for the render before the effect runs.
  return held && held.roomName === roomName ? held.session : null;
}
