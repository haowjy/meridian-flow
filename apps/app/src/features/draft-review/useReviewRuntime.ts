/**
 * React's side of the review runtime (`review-runtime.ts`): read a draft's state, hold its runtime while a
 * surface needs it, and read an unopened draft's room for a row that is expanded. Readers subscribe to the
 * runtime's state, not to the room: the Y.Doc is subscribed to once, by the runtime.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
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

/** The draft's review state, whoever holds its runtime. Empty while none does. */
export function useReviewState(draft: DraftRef | null): ReviewState {
  const key = draft ? draftCommandKey(draft) : NO_KEY;
  return useSyncExternalStore(
    (listener) => watchReviewState(key, listener),
    () => reviewStateOf(key),
    () => reviewStateOf(NO_KEY),
  );
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
  retry: (() => void) | undefined;
} & (
  | { status: "ready"; roomName: string }
  | { status: "ready"; roomName: null; branchless: true }
  | { status: Exclude<RoomReviewStatus, "ready">; roomName: null }
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
  const { meta, failed, retry } = useDraftMeta(draft, { enabled: active });
  const roomName = metaRoomName(meta);
  const session = useBranchRoom(active ? roomName : null, retry);
  useReviewRuntime(active ? draft : null, session);
  const { ready } = useReviewState(active ? draft : null);

  const status: RoomReviewStatus = !active
    ? "idle"
    : meta?.kind === "gone"
      ? "gone"
      : failed
        ? "error"
        : meta?.kind === "branchless" || (ready && session)
          ? "ready"
          : "loading";
  const branchless = meta?.kind === "branchless";
  const common = {
    wholeItem: meta !== null && meta.kind !== "gone" && meta.wholeItem,
    branchless,
    retry: failed ? retry : undefined,
  };
  if (status !== "ready") return { ...common, status, roomName: null };
  return roomName
    ? { ...common, status, roomName }
    : { ...common, status, roomName: null, branchless: true };
}
