/**
 * React's hold on a branch room: what the room is to this surface while it needs it (`readBranchRoom`'s
 * state, mirrored), and a call to `onUnavailable` when the room can no longer be used as named. The room
 * itself is `readBranchRoom`'s; this only mirrors it into state.
 *
 * `session` is what an editor presents (the usable session, or the schema-fenced one that carries the
 * notice); `usable` is the session a command or input may act on. `retry` asks the room again after an
 * `error` or `unavailable`, with the room still held.
 */
import { useEffect, useRef, useState } from "react";
import { type BranchRoomState, readBranchRoom } from "@/core/editor/branch-room-read";
import type { DocumentSession } from "@/core/editor/document-session";
import { useLiveDocumentSessionRegistry } from "@/features/project/context/account-feature-context";

export type BranchRoomView = {
  state: BranchRoomState["kind"] | "idle";
  session: DocumentSession | null;
  usable: DocumentSession | null;
  error: unknown;
  retry: () => void;
};

const NONE: BranchRoomView = {
  state: "idle",
  session: null,
  usable: null,
  error: undefined,
  retry: () => {},
};

export function useBranchRoom(roomName: string | null, onUnavailable?: () => void): BranchRoomView {
  const registry = useLiveDocumentSessionRegistry();
  const [held, setHeld] = useState<{ roomName: string; view: BranchRoomView } | null>(null);
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;

  useEffect(() => {
    if (!roomName) {
      setHeld(null);
      return;
    }
    const read = readBranchRoom(registry, roomName);
    const follow = () => {
      const state = read.state();
      setHeld({
        roomName,
        view: {
          state: state.kind,
          session: read.session(),
          usable: read.usable(),
          error: state.kind === "error" ? state.error : undefined,
          retry: read.retry,
        },
      });
      if (state.kind === "unavailable") unavailable.current?.();
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
  return held && held.roomName === roomName ? held.view : NONE;
}
