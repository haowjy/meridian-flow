/**
 * Discards that leave a row behind on a surface without an editor (the chat's draft dock, the Work page's rows).
 * A change the expanded row shows is a local edit of the room that row already holds (`discardChange`,
 * synchronous): its entry exists only once the edit does, and reads "Discarded" with Undo. A chat's
 * changes in a collapsed file need a room acquired first, so that entry is `pending` (shown as
 * "Discarding", cancelled by Undo) until the edit lands.
 *
 * An entry owns its history and a lease on its room until Undo, so collapsing, filtering or reopening the
 * file never retires the document the Undo writes into. The hook's lifetime is the surface's and, beneath
 * it, one Work's: leaving the surface or rebinding the chat to another Work ends every Undo (the Discards
 * stay): the leases are released, the histories dropped, pending work cancelled and its late completion
 * fenced out by the scope's epoch. The persistent chat is never remounted for it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { DraftRef } from "@/client/query/draft-command-record";
import { draftMetaQueryOptions } from "@/client/query/useDraftMeta";
import type { DiscardSubject } from "@/client/query/work-draft-files";
import { type BranchRoomRead, readBranchRoom, withLiveRoom } from "@/core/editor/branch-room-read";
import type { DocumentSession } from "@/core/editor/document-session";
import { isSameChange } from "@/core/editor/extensions/inline-review";
import { useLiveDocumentSessionRegistry } from "@/features/project/context/account-feature-context";
import { chatChangeTargets } from "./chat-changes";
import type { ReviewChange } from "./review-model";
import { discardClickedChange, discardInRoom, type RoomDiscard } from "./room-discard";

/** Where a Discard stands: `pending` while its room is acquired, `discarded` once the edit exists. */
export type DiscardPhase = "pending" | "discarded" | "failed";

/** What an Undo row keeps of a discarded change: its identity (id and pin) and what it said, never its frame. */
export type DiscardedChange = Pick<ReviewChange, "id" | "pin" | "excerpt">;

/** One Discard the row still offers to undo: a single change, or (change null) a chat's changes in the file. */
export type DiscardedEntry = {
  id: string;
  subject: DiscardSubject;
  change: DiscardedChange | null;
  /** Where the change sat among its file's changes, so its row comes back in place. */
  index: number;
  phase: DiscardPhase;
};

/** The edit's history, or the promise of it while the room is acquired. */
type Held = RoomDiscard | Promise<RoomDiscard | null>;

export type HeadlessDiscards = {
  entries: readonly DiscardedEntry[];
  /** Discard the change its row drew, in the room that row reads: the edit is made before this returns. */
  discardChange: (
    subject: DiscardSubject,
    change: ReviewChange,
    index: number,
    roomName: string,
  ) => void;
  /** Discard every change of the file's draft in the room its review reads: the edit is made before this returns. */
  discardAll: (subject: DiscardSubject, roomName: string) => void;
  /** Discard only the changes that belong to this chat (its membership). */
  discardFile: (subject: DiscardSubject, threadId: string) => void;
  /** Revert a landed Discard, cancel a pending one, or dismiss a failed one. */
  undo: (entryId: string) => void;
};

let sequence = 0;
const NO_ENTRIES: readonly DiscardedEntry[] = [];
const NOTHING: RoomDiscard = { undo: () => {}, release: () => {} };

/**
 * `extent` narrows the scope below the Work (the phone's one open review): when it changes, every Undo
 * ends the way a rebind of the Work ends it.
 */
export function useHeadlessDiscards(
  projectId: string,
  workId: string,
  extent = "",
): HeadlessDiscards {
  const queryClient = useQueryClient();
  const registry = useLiveDocumentSessionRegistry();
  const scope = `${projectId}:${workId}:${extent}`;
  const [held, setHeld] = useState<{ scope: string; entries: readonly DiscardedEntry[] }>({
    scope,
    entries: [],
  });
  // Rows of an earlier Work are never shown, not even for the render before the scope's cleanup runs.
  const entries = held.scope === scope ? held.entries : NO_ENTRIES;
  const setEntries = useCallback(
    (update: (entries: readonly DiscardedEntry[]) => readonly DiscardedEntry[]) =>
      setHeld((current) => ({
        scope,
        entries: update(current.scope === scope ? current.entries : NO_ENTRIES),
      })),
    [scope],
  );
  const histories = useRef(new Map<string, Held>());
  /** The room each entry's history writes into, held for as long as the entry is. */
  const reads = useRef(new Map<string, BranchRoomRead>());
  /** Ends each entry's watch on the session its history was written into. */
  const watches = useRef(new Map<string, () => void>());
  /** Bumps whenever the scope ends; work begun under an earlier epoch must not publish. */
  const epoch = useRef(0);

  useEffect(() => {
    const held = histories.current;
    const leased = reads.current;
    const watching = watches.current;
    return () => {
      epoch.current += 1;
      for (const done of held.values()) {
        if (done instanceof Promise) void done.then((result) => result?.release());
        else done.release();
      }
      held.clear();
      for (const read of leased.values()) read.dispose();
      leased.clear();
      for (const stop of watching.values()) stop();
      watching.clear();
    };
  }, [scope]);

  /** Let go of the room this entry holds, keeping every other entry's room. */
  const release = useCallback((entryId: string) => {
    watches.current.get(entryId)?.();
    watches.current.delete(entryId);
    reads.current.get(entryId)?.dispose();
    reads.current.delete(entryId);
  }, []);

  /**
   * An entry's Undo is the history of one session. When that session retires (the server refused its
   * edits and the room was rebuilt, or the draft closed) the Discard never reached the current room:
   * the entry reads failed and its Undo is gone. The refused edit is never replayed into the replacement.
   */
  const bindToSession = useCallback(
    (entryId: string, read: BranchRoomRead, session: DocumentSession) => {
      const check = () => {
        if (read.usable() === session) return;
        watches.current.get(entryId)?.();
        watches.current.delete(entryId);
        const history = histories.current.get(entryId);
        histories.current.delete(entryId);
        if (history && !(history instanceof Promise)) history.release();
        setEntries((held) =>
          held.map((entry) =>
            entry.id === entryId && entry.phase === "discarded"
              ? { ...entry, phase: "failed" }
              : entry,
          ),
        );
      };
      watches.current.set(entryId, read.subscribe(check));
    },
    [setEntries],
  );

  const write = useCallback(
    (
      subject: DiscardSubject,
      change: ReviewChange | null,
      index: number,
      roomName: string,
      edit: (doc: Y.Doc) => RoomDiscard | null,
    ) => {
      const id = `${subject.itemKey}:${++sequence}`;
      let result: RoomDiscard | null = null;
      const read = readBranchRoom(registry, roomName);
      // The expanded row's reader holds this room, so it is usable now; this entry's read keeps it so for Undo.
      const session = read.usable();
      try {
        if (session) result = edit(session.document);
      } catch {
        // A failed write leaves the failed entry below.
      }
      if (result && session) {
        histories.current.set(id, result);
        reads.current.set(id, read);
        bindToSession(id, read, session);
      } else read.dispose();
      setEntries((held) => [
        ...held,
        {
          id,
          subject,
          change: change && { id: change.id, pin: change.pin, excerpt: change.excerpt },
          index,
          phase: result ? "discarded" : "failed",
        },
      ]);
    },
    [registry, setEntries, bindToSession],
  );

  const discardFile = useCallback(
    (subject: DiscardSubject, threadId: string) => {
      const id = `${subject.itemKey}:${++sequence}`;
      const draft: DraftRef = {
        projectId,
        workId,
        documentId: subject.documentId,
        itemKey: subject.itemKey,
      };
      const born = epoch.current;
      const current = () => epoch.current === born;
      setEntries((held) => [...held, { id, subject, change: null, index: 0, phase: "pending" }]);
      const done = (async () => {
        const meta = await queryClient.fetchQuery(draftMetaQueryOptions(draft));
        if (meta.kind !== "text" || !current()) return null;
        // Cancelled while the room was looked up: nothing is leased or written.
        if (!histories.current.has(id)) return NOTHING;
        const read = readBranchRoom(registry, meta.roomName);
        reads.current.set(id, read);
        // The room is checked again after each await: a session that retired meanwhile is not written into.
        return withLiveRoom(read, async (room) => {
          const { targets } = await chatChangeTargets(queryClient, draft, room.document, threadId);
          // Cancelled while preparing: nothing is written.
          if (!histories.current.has(id)) return NOTHING;
          // The hint misses this file: nothing of this chat's to discard, so the row never flips.
          if (targets.length === 0) return NOTHING;
          read.assertLive(room);
          const result = discardInRoom(
            room.document,
            targets.map((target) => target.id),
          );
          if (result) bindToSession(id, read, room);
          return result;
        });
      })().catch(() => null);
      histories.current.set(id, done);
      void done.then((result) => {
        if (!current() || !histories.current.has(id)) return;
        if (result === NOTHING) {
          histories.current.delete(id);
          release(id);
          setEntries((held) => held.filter((entry) => entry.id !== id));
          return;
        }
        // The room retired between the edit and this settling: the Discard is not in the current room.
        const stale = result !== null && reads.current.get(id)?.usable() === null;
        if (stale) result.release();
        const phase: DiscardPhase = result && !stale ? "discarded" : "failed";
        if (result && !stale) histories.current.set(id, result);
        else histories.current.delete(id);
        setEntries((held) => held.map((entry) => (entry.id === id ? { ...entry, phase } : entry)));
      });
    },
    [projectId, workId, queryClient, registry, release, setEntries, bindToSession],
  );

  const undo = useCallback(
    (entryId: string) => {
      const done = histories.current.get(entryId);
      histories.current.delete(entryId);
      release(entryId);
      setEntries((held) => held.filter((entry) => entry.id !== entryId));
      if (done instanceof Promise) void done.then((result) => result?.undo());
      else done?.undo();
    },
    [release, setEntries],
  );

  return {
    entries,
    discardChange: (subject, change, index, roomName) => {
      // Ids are occurrence ranks, so two clicks on one row are told apart by the pinned place, not the id.
      const again = entries.some(
        (entry) => entry.change && isSameChange(entry.change, change.id, change.pin),
      );
      if (!again)
        write(subject, change, index, roomName, (doc) =>
          discardClickedChange(doc, { id: change.id, pin: change.pin }),
        );
    },
    discardAll: (subject, roomName) =>
      write(subject, null, 0, roomName, (doc) => discardInRoom(doc, "all")),
    discardFile,
    undo,
  };
}
