/** Headless and open surfaces retain the rooms on screen and subscribe to one projection per room. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDraftMetadata } from "@/client/query/useDraftMetadata";
import type { DocumentSession } from "@/core/editor/document-session";
import { type DraftRoomRead, readDraftRoom } from "@/core/editor/draft-room-read";
import {
  useDraftCommandOwner,
  useLiveDocumentSessionRegistry,
} from "@/features/project/context/account-feature-context";
import type { DraftRef } from "./review-command-types";
import { EMPTY_REVIEW_STATE, type ReviewRuntime, retainReviewRuntime } from "./review-runtime";

import { retainRoomAttribution } from "./room-attribution";

type HeldReview = {
  runtime: ReviewRuntime | null;
  read: DraftRoomRead;
  session: DocumentSession | null;
};
export function useRoomBindings(drafts: readonly DraftRef[]) {
  const registry = useLiveDocumentSessionRegistry();
  const owner = useDraftCommandOwner();
  const metadata = useDraftMetadata(drafts);
  const names = metadata.map((entry) =>
    entry.data?.status === "active" ? entry.data.reviewRoomName : null,
  );
  const namesKey = JSON.stringify(names);
  const metadataKey = JSON.stringify(
    metadata.map((result, index) => [
      drafts[index].projectId,
      drafts[index].workId,
      drafts[index].documentId,
      drafts[index].itemKey,
      result.dataUpdatedAt,
      result.data?.status,
      result.isError,
    ]),
  );
  useEffect(() => {
    for (const [index, result] of metadata.entries())
      if (result.data?.status === "gone") void owner.metadataGone(drafts[index]);
  }, [metadataKey, owner]);
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
      let releaseAttribution = () => {};
      const publish = () =>
        setHeld((prior) =>
          new Map(prior).set(name, {
            read,
            session,
            runtime,
          }),
        );
      const follow = () => {
        const next = read.session();
        if (next !== session) {
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
        }
        publish();
      };
      const unwatch = read.subscribe(follow);
      follow();
      leases.current.set(name, () => {
        unwatch();
        releaseAttribution();
        release();
        read.dispose();
      });
    }
  }, [namesKey, registry, owner]);
  return useMemo(
    () =>
      drafts.map((_draft, index) => {
        const name = names[index];
        const current = name ? held.get(name) : null;
        const meta = metadata[index];
        const fault = current?.read.state().kind;
        const status =
          meta?.data?.status === "gone"
            ? "gone"
            : meta?.isError || fault === "error" || fault === "unavailable"
              ? "error"
              : current?.session
                ? "ready"
                : "loading";
        return {
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
      }),
    [held, metadataKey, namesKey],
  );
}

export function useRoomReviews(drafts: readonly DraftRef[]) {
  const bindings = useRoomBindings(drafts);
  const owner = useDraftCommandOwner();
  const store = useMemo(() => {
    const runtimes = bindings.map((binding) => binding.runtime);
    const itemKeys = drafts.map((draft) => draft.itemKey);
    const read = () =>
      runtimes.map((runtime, index) => ({
        review: runtime?.state() ?? EMPTY_REVIEW_STATE,
        command: owner.state(itemKeys[index]),
      }));
    let states = read();
    return {
      subscribe(listener: () => void) {
        const stops = [
          owner.subscribe(listener),
          ...runtimes.map((runtime) => runtime?.subscribe(listener)),
        ];
        return () => {
          for (const stop of stops) stop?.();
        };
      },
      snapshot() {
        const next = read();
        if (
          next.some(
            (state, i) => state.review !== states[i].review || state.command !== states[i].command,
          )
        )
          states = next;
        return states;
      },
    };
  }, [bindings, owner]);
  const states = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return bindings.map((binding, index) => {
    const state = states[index].review;
    const discarding = states[index].command.discarding;
    return {
      ...binding,
      ...state,
      listedChanges: discarding
        ? state.changes.filter((change) => !discarding(change))
        : state.changes,
      status: binding.status === "ready" && !state.ready ? ("loading" as const) : binding.status,
    };
  });
}
export function useRoomReview(draft: DraftRef | null) {
  return (
    useRoomReviews(draft ? [draft] : [])[0] ?? {
      ...EMPTY_REVIEW_STATE,
      listedChanges: [],
      status: "idle" as const,
      runtime: null,
      roomName: null,
      session: null,
      usable: null,
      retry: () => {},
    }
  );
}
