/**
 * React's side of the review runtime (`review-runtime.ts`): read a draft's state, hold its runtime while a
 * surface needs it, and read an unopened draft's room for a row that is expanded. Readers subscribe to the
 * runtime's state, not to the room: the Y.Doc is subscribed to once, by the runtime.
 */
import { useQueryClient } from "@tanstack/react-query";
import { startTransition, useEffect, useLayoutEffect, useRef, useState } from "react";
import { shallow } from "zustand/shallow";
import { type DraftRef, draftCommandKey } from "@/client/query/draft-command-record";
import { metaRoomName, useDraftMeta } from "@/client/query/useDraftMeta";
import {
  type ReviewRoom,
  type ReviewState,
  retainReviewRuntime,
  reviewStateOf,
  watchReviewState,
} from "./review-runtime";
import { useBranchRoom } from "./useBranchRoom";

const NO_KEY = "";

/** Select only what this reader displays; frame publication must not wake readiness/focus owners. */
export function useReviewState(draft: DraftRef | null): ReviewState;
export function useReviewState<T>(draft: DraftRef | null, select: (state: ReviewState) => T): T;
export function useReviewState(
  draft: DraftRef | null,
  select: (state: ReviewState) => unknown = (state) => state,
): unknown {
  const key = draft ? draftCommandKey(draft) : NO_KEY;
  // Review chrome may lag the painter. Keep its immutable, frame-bound command targets together
  // in a transition; useSyncExternalStore notifications are synchronous even inside startTransition.
  const [snapshot, setSnapshot] = useState(() => ({ key, value: select(reviewStateOf(key)) }));
  const latest = useRef(snapshot);
  // Re-read with this render's selector: a selector may close over props (a focused id), so a render can
  // change what it selects without any publication. Shallow-equal results keep the previous value.
  const sync = () => {
    const value = select(reviewStateOf(key));
    const prev = latest.current;
    if (prev.key === key && shallow(prev.value, value)) return;
    latest.current = { key, value };
    setSnapshot(latest.current);
  };
  const current = useRef(sync);
  useLayoutEffect(() => {
    current.current = sync;
    sync();
  });
  // One subscription per draft; a publication re-reads through the latest render's selector.
  useLayoutEffect(
    () => watchReviewState(key, () => startTransition(() => current.current())),
    [key],
  );
  return snapshot.key === key ? snapshot.value : select(reviewStateOf(key));
}

/** Hold the draft's runtime while `room` is its room. */
export function useReviewRuntime(draft: DraftRef | null, room: ReviewRoom | null): void {
  const queryClient = useQueryClient();
  const key = draft ? draftCommandKey(draft) : NO_KEY;
  useEffect(() => {
    if (!draft || !room) return;
    return retainReviewRuntime(draft, room, queryClient);
  }, [key, room, queryClient]);
}

export type RoomReviewStatus = "idle" | "loading" | "error" | "ready" | "gone";

/**
 * What a reader gets of an unopened draft's room. `ready` means the room is held and synced and its
 * frames can be read, so it carries the room's name, the capability a Discard needs to take its own lease
 * on the room; no other status has a room to act on.
 */
export type RoomReview = {
  /** The item is one whole change (created, binary or live-deleted): only item-level commands act on it. */
  wholeItem: boolean;
  /** The item has no text branch (a created image or blank create): nothing to project, one item-level change. */
  branchless: boolean;
} & (
  | { status: "ready"; roomName: string; retry: undefined }
  | { status: "ready"; roomName: null; branchless: true; retry: undefined }
  | { status: "error"; roomName: null; retry: () => void }
  | { status: Exclude<RoomReviewStatus, "ready" | "error">; roomName: null; retry: undefined }
);

/**
 * An unopened draft's room, read while `enabled` (a Work page or draft dock row is expanded): the room is
 * retained read-only and its runtime held. What the room says is `useReviewState`'s, so a draft some
 * editor has open shares the editor's frames.
 */
export function useRoomReview(
  draft: DraftRef | null,
  { enabled }: { enabled: boolean },
): RoomReview {
  const active = enabled && draft !== null;
  const { meta, failed, fetching, retry } = useDraftMeta(draft, { enabled: active });
  const roomName = metaRoomName(meta);
  const room = useBranchRoom(active ? roomName : null, retry);
  const session = room.usable;
  useReviewRuntime(active ? draft : null, room.session);
  // A room that failed to open, or that the metadata still names after it ended, is a recoverable error:
  // never an endless first load. Once the refresh settles with the same room, only Retry reopens it.
  const roomFault = room.state === "error" || (room.state === "unavailable" && !fetching);
  const retryAll = () => {
    room.retry();
    retry();
  };
  const ready = useReviewState(active ? draft : null, (state) => state.ready);

  const status: RoomReviewStatus = !active
    ? "idle"
    : meta?.kind === "gone"
      ? "gone"
      : failed || roomFault
        ? "error"
        : meta?.kind === "branchless" || (ready && session)
          ? "ready"
          : "loading";
  const branchless = meta?.kind === "branchless";
  const common = {
    wholeItem: meta !== null && meta.kind !== "gone" && meta.wholeItem,
    branchless,
    retry: undefined,
  };
  if (status === "error") return { ...common, status, roomName: null, retry: retryAll };
  if (status !== "ready") return { ...common, status, roomName: null };
  return roomName
    ? { ...common, status, roomName }
    : { ...common, status, roomName: null, branchless: true };
}
