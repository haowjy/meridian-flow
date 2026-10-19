/** Headless and open surfaces retain the rooms on screen and subscribe to one projection per room. */
import { useEffect, useRef, useState } from "react";
import { useDraftMetadata } from "@/client/query/useDraftMetadata";
import type { DocumentSession } from "@/core/editor/document-session";
import { type DraftRoomRead, readDraftRoom } from "@/core/editor/draft-room-read";
import {
  useDraftCommandOwner,
  useLiveDocumentSessionRegistry,
} from "@/features/project/context/account-feature-context";
import type { DraftRef } from "./review-command-types";
import {
  EMPTY_REVIEW_STATE,
  type ReviewRuntime,
  type ReviewState,
  retainReviewRuntime,
} from "./review-runtime";

import { retainRoomAttribution } from "./room-attribution";

type HeldReview = {
  state: ReviewState;
  runtime: ReviewRuntime | null;
  read: DraftRoomRead;
  session: DocumentSession | null;
};
export function useRoomReviews(drafts: readonly DraftRef[]) {
  const registry = useLiveDocumentSessionRegistry();
  const owner = useDraftCommandOwner();
  const metadata = useDraftMetadata(drafts);
  const names = metadata.map((entry) =>
    entry.data?.status === "active" ? entry.data.reviewRoomName : null,
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
      let releaseAttribution = () => {};
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
          releaseAttribution();
          release();
          session = next;
          const draft = drafts[names.indexOf(name)];
          const hold = next ? retainReviewRuntime(next) : null;
          const detach = next && draft ? owner.bind(draft, next) : () => {};
          runtime = hold?.runtime ?? null;
          release = () => {
            detach();
            hold?.release();
          };
          releaseAttribution =
            next && runtime ? retainRoomAttribution(next, runtime, draft) : () => {};
          unwatchRuntime = runtime?.subscribe(publish) ?? (() => {});
        }
        publish();
      };
      const unwatch = read.subscribe(follow);
      follow();
      leases.current.set(name, () => {
        unwatch();
        unwatchRuntime();
        releaseAttribution();
        release();
        read.dispose();
      });
    }
  }, [namesKey, registry, owner]);
  return drafts.map((_draft, index) => {
    const name = names[index];
    const current = name ? held.get(name) : null;
    const meta = metadata[index];
    const state = current?.state ?? EMPTY_REVIEW_STATE;
    const fault = current?.read.state().kind;
    const status =
      meta?.isError || fault === "error" || fault === "unavailable"
        ? "error"
        : meta?.data?.status === "gone"
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
        current?.read.retry ??
        (meta?.isError ? () => void meta.refetch() : undefined) ??
        (() => {}),
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
