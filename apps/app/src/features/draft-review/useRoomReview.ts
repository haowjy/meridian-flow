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
  // A draft that closed while on screen keeps its room: its text stays, read-only, in Trash.
  const shownRooms = useRef(new Map<string, string>());
  const names = metadata.map((entry, index) => {
    const itemKey = drafts[index].itemKey;
    if (entry.data?.status === "active") {
      shownRooms.current.set(itemKey, entry.data.reviewRoomName);
      return entry.data.reviewRoomName;
    }
    if (entry.data?.status === "gone") return shownRooms.current.get(itemKey) ?? null;
    shownRooms.current.delete(itemKey);
    return null;
  });
  const namesKey = JSON.stringify(names);
  const metadataKey = JSON.stringify(
    metadata.map((result, index) => [
      drafts[index].projectId,
      drafts[index].ownerKey,
      drafts[index].documentId,
      drafts[index].itemKey,
      result.dataUpdatedAt,
      result.data?.status,
      result.isError,
    ]),
  );
  const [held, setHeld] = useState<ReadonlyMap<string, HeldReview>>(new Map());
  const leases = useRef(new Map<string, () => void>());
  const reads = useRef(new Map<string, DraftRoomRead>());
  // The answer each room last asked again on: one retry per answer, so a room that keeps failing
  // waits for the next one.
  const retriedOn = useRef(new Map<string, number>());
  const roomsKey = JSON.stringify([...held].map(([name, room]) => [name, room.read.state().kind]));
  useEffect(() => {
    for (const [index, result] of metadata.entries()) {
      const { data } = result;
      if (data?.status === "gone") void owner.askEnd(drafts[index]);
      // A room that failed tries again on each new answer that names its draft open.
      else if (data?.status === "active") {
        const read = reads.current.get(data.reviewRoomName);
        const kind = read?.state().kind;
        if (
          kind !== undefined &&
          kind !== "usable" &&
          kind !== "rebuilding" &&
          retriedOn.current.get(data.reviewRoomName) !== result.dataUpdatedAt
        ) {
          retriedOn.current.set(data.reviewRoomName, result.dataUpdatedAt);
          read?.retry();
        }
      }
    }
  }, [metadataKey, roomsKey, owner]);
  useEffect(
    () => () => {
      for (const release of leases.current.values()) release();
      leases.current.clear();
      reads.current.clear();
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
      reads.current.delete(name);
      setHeld((prior) => {
        const next = new Map(prior);
        next.delete(name);
        return next;
      });
    }
    for (const name of wanted) {
      if (leases.current.has(name)) continue;
      const read = readDraftRoom(registry, {
        roomKey: name,
        documentId: drafts[names.indexOf(name)].documentId,
      });
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
      reads.current.set(name, read);
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
        const roomFailed = fault === "error" || fault === "unavailable";
        // Cached active metadata still addresses the retained room after a refetch fails.
        const metadataFailed = meta?.isError && !name;
        const status =
          meta?.data?.status === "tree-only"
            ? ("ready" as const)
            : // A room this tab still holds stays on screen after its draft closed (in Trash).
              meta?.data?.status === "gone" && !current?.session
              ? "gone"
              : metadataFailed || roomFailed
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
          // A fenced room retries only when its updates were refused (`readDraftRoom`).
          retry:
            roomFailed || fault === "fenced"
              ? current!.read.retry
              : meta?.isError
                ? () => void meta.refetch()
                : () => {},
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
