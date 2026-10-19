/** Headless and open surfaces retain the rooms on screen and subscribe to one projection per room. */
import { useEffect, useRef, useState } from "react";
import { useDraftPreviews } from "@/client/query/useDraftPreview";
import type { DocumentSession } from "@/core/editor/document-session";
import { type DraftRoomRead, readDraftRoom } from "@/core/editor/draft-room-read";
import { useLiveDocumentSessionRegistry } from "@/features/project/context/account-feature-context";
import type { DraftRef } from "./review-command-types";
import {
  EMPTY_REVIEW_STATE,
  type ReviewRuntime,
  type ReviewState,
  retainReviewRuntime,
} from "./review-runtime";

type HeldReview = {
  state: ReviewState;
  runtime: ReviewRuntime | null;
  read: DraftRoomRead;
  session: DocumentSession | null;
};
export function useRoomReviews(drafts: readonly DraftRef[]) {
  const registry = useLiveDocumentSessionRegistry();
  const metadata = useDraftPreviews(drafts);
  const names = metadata.map((entry) =>
    entry.status === "ready" && entry.preview.status === "active"
      ? entry.preview.reviewRoomName
      : null,
  );
  const namesKey = JSON.stringify(names);
  const [held, setHeld] = useState<ReadonlyMap<string, HeldReview>>(new Map());
  const leases = useRef(new Map<string, () => void>());
  useEffect(
    () => () => {
      for (const release of leases.current.values()) release();
      leases.current.clear();
      setHeld(new Map());
    },
    [registry],
  );
  useEffect(() => {
    const wanted = new Set(names.filter((name): name is string => name !== null));
    for (const [name, release] of leases.current) {
      if (wanted.has(name)) continue;
      release();
      leases.current.delete(name);
      setHeld((prior) => {
        const next = new Map(prior);
        next.delete(name);
        return next;
      });
    }
    for (const name of wanted) {
      if (leases.current.has(name)) continue;
      const read = readDraftRoom(registry, name);
      let session: DocumentSession | null = null;
      let runtime: ReviewRuntime | null = null;
      let release = () => {};
      let unwatchRuntime = () => {};
      const publish = () =>
        setHeld((prior) =>
          new Map(prior).set(name, {
            read,
            session,
            runtime,
            state: runtime?.state() ?? EMPTY_REVIEW_STATE,
          }),
        );
      const follow = () => {
        const next = read.session();
        if (next !== session) {
          unwatchRuntime();
          release();
          session = next;
          const hold = next ? retainReviewRuntime(next) : null;
          runtime = hold?.runtime ?? null;
          release = hold?.release ?? (() => {});
          unwatchRuntime = runtime?.subscribe(publish) ?? (() => {});
        }
        publish();
      };
      const unwatch = read.subscribe(follow);
      follow();
      leases.current.set(name, () => {
        unwatch();
        unwatchRuntime();
        release();
        read.dispose();
      });
    }
  }, [namesKey, registry]);
  return drafts.map((_draft, index) => {
    const name = names[index];
    const current = name ? held.get(name) : null;
    const meta = metadata[index];
    const state = current?.state ?? EMPTY_REVIEW_STATE;
    const fault = current?.read.state().kind;
    const status =
      meta?.status === "error" || fault === "error" || fault === "unavailable"
        ? "error"
        : meta?.status === "ready" && meta.preview.status === "gone"
          ? "gone"
          : state.ready
            ? "ready"
            : "loading";
    return {
      ...state,
      status,
      runtime: current?.runtime ?? null,
      roomName: name ?? null,
      session: current?.session ?? null,
      usable: current?.read.usable() ?? null,
      retry:
        current?.read.retry ?? (meta?.status === "error" ? meta.retry : undefined) ?? (() => {}),
    } as const;
  });
}
export function useRoomReview(draft: DraftRef | null) {
  return (
    useRoomReviews(draft ? [draft] : [])[0] ?? {
      ...EMPTY_REVIEW_STATE,
      status: "idle" as const,
      runtime: null,
      roomName: null,
      session: null,
      usable: null,
      retry: () => {},
    }
  );
}
