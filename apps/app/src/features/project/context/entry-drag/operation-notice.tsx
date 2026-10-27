/**
 * The notice a surface shows for the writer's latest Move or Copy ("Moved chapter-3 to Act 2.",
 * "Copying chapter-3 to Vault…") with Undo, on the surface that took it (a drop, Move… or
 * Copy to…). One owner per project holds each surface's latest operation: what it did, which
 * rows the server refused since, whether Undo still has something to take back (both read from
 * the replica, so it needs no list on screen), and Undo itself. The notice shares its surface's
 * one notice place with delete notices (`useNoticeSlot`); a newer notice of either kind replaces
 * it. It stays until then, Dismiss, or leaving the project: Undo is not a race. After Undo the
 * notice leaves at once but its surface keeps watching the reverse operations, off screen, until
 * the server answers each, so a refused Undo comes back as "Couldn't move X back.". A refusal
 * names the row as it was, so it leaves once that row is renamed or gone.
 *
 * What an operation says, how it follows the server and how it is taken back belongs to its
 * kind (`move-operation.ts`, `copy-operation.ts`); the phases around that are the same for all.
 *
 * Delete's notice stays apart (`document-delete-undo.tsx`). Its Undo is a server restore of
 * removed documents, with its own retry, failure copy and tab handling, not ordinary operations
 * the replica answers one by one; the phases here would bend both.
 */

import type { FolderNamespaceRecord, OperationRecord } from "@meridian/resource-replica";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type NoticeSurface, SurfaceNotice, useNoticeSlot } from "../../shell/SurfaceNotice";
import {
  useAccountResourceProjection,
  useAccountResourceReplica,
} from "../account-feature-context";
import type { EntryRef } from "./entry";
import type { MoveContext } from "./execute-move";
import { entryNameNow, intentSettlement, type PlacementView } from "./move-plan";

/** A row an operation could not take back or the replica would not admit. */
export type Failure = { entry: EntryRef; name: string; action: "move" | "reorder" | "delete" };

/** An operation Undo admitted, followed until the server answers; `ifRefused` is what a refusal reports. */
export type Followed = { entry: EntryRef; operationId: string; ifRefused: Failure };

/** What the replica shows now: placement, the folder journal and the operations journal (null until loaded). */
export type NoticeView = PlacementView & {
  folders: readonly FolderNamespaceRecord[];
  operations: readonly OperationRecord[] | null;
};

/**
 * One kind of operation as a notice follows it. Immutable: `settlement` returns the same object
 * when nothing changed (the notice re-reads on every projection), a new one when the replica or
 * the server has said something, null once there is nothing left to say.
 */
export interface Operation {
  /** The rows it made or moved, for the list that took it to select. */
  readonly rows: readonly EntryRef[];
  /** What the notice says. */
  readonly message: string;
  /** Something is still where the operation put it. */
  readonly undoable: boolean;
  settlement(view: NoticeView): Operation | null;
  /** Takes it back as ordinary operations through the replica. */
  undo(
    context: MoveContext,
  ): Promise<{ failed: readonly Failure[]; followed: readonly Followed[] }>;
  /** What the notice says when Undo could not put back `failed` (empty when it threw before naming any). */
  describeUndoFailure(failed: readonly Failure[]): string;
}

type Active = {
  phase: "active";
  /** Stays with the notice through every phase, so a stale answer can't touch a newer one. */
  id: number;
  operation: Operation;
  /** Puts focus back in a mounted list when the notice leaves under it. */
  refocus?: () => void;
};

/**
 * One surface's latest operation, by phase. Only `active` offers Undo, and only `reversing` is
 * off screen; what the notice says follows from the phase.
 */
type NoticeWindow =
  | Active
  /** The replica is admitting Undo's reverse operations; the notice stays, its Undo disabled. */
  | { phase: "undoing"; id: number; active: Active }
  /** Undo closed the notice; it comes back only if the server refuses one of `pending`. */
  | {
      phase: "reversing";
      id: number;
      operation: Operation;
      pending: readonly Followed[];
      refocus?: () => void;
    }
  /**
   * Rows Undo could not put back, the replica's refusals and the server's together; no
   * `failed` means Undo threw before naming any. Still watches the rest of its reverse
   * operations, which can only add to the count.
   */
  | {
      phase: "undo-failed";
      id: number;
      operation: Operation;
      failed: readonly Failure[];
      pending: readonly Followed[];
      refocus?: () => void;
    };

type OperationNotices = {
  windows: ReadonlyMap<NoticeSurface, NoticeWindow>;
  publish: (surface: NoticeSurface, operation: Operation, refocus?: () => void) => void;
  /**
   * Resolves true once the replica took every row back and the notice closed;
   * the notice returns if the server then refuses one.
   */
  undo: (surface: NoticeSurface, id: number) => Promise<boolean>;
  dismiss: (surface: NoticeSurface, id: number) => void;
};

const OperationNoticesContext = createContext<OperationNotices | null>(null);

type OperationFeedback = {
  surface: NoticeSurface;
  select?: (rows: readonly EntryRef[]) => void;
  refocus?: () => void;
};

const OperationFeedbackContext = createContext<OperationFeedback | null>(null);

let nextNoticeId = 1;

export function OperationNoticesProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const resources = useAccountResourceReplica();
  const { records, folders, placement, snapshot } = useAccountResourceProjection(projectId);
  const view = useMemo<NoticeView>(
    () => ({ records, folders, placement, operations: snapshot?.operations ?? null }),
    [records, folders, placement, snapshot],
  );
  const slots = useNoticeSlot();
  const [windows, setWindows] = useState<ReadonlyMap<NoticeSurface, NoticeWindow>>(() => new Map());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Replaces or clears notice `id`, unless a newer one has taken its surface. */
  const settle = useCallback(
    (surface: NoticeSurface, id: number, next: (now: NoticeWindow) => NoticeWindow | null) => {
      if (!mounted.current) return;
      setWindows((current) => {
        const now = current.get(surface);
        if (now?.id !== id) return current;
        const replaced = next(now);
        const map = new Map(current);
        if (replaced) map.set(surface, replaced);
        else map.delete(surface);
        return map;
      });
    },
    [],
  );
  const dismiss = useCallback(
    (surface: NoticeSurface, id: number) => settle(surface, id, () => null),
    [settle],
  );

  const publish = useCallback<OperationNotices["publish"]>(
    (surface, operation, refocus) => {
      // An operation can finish after its project has gone; there is nowhere to say so.
      if (!mounted.current) return;
      const id = nextNoticeId++;
      setWindows((current) =>
        new Map(current).set(surface, { phase: "active", id, operation, refocus }),
      );
      slots.take(surface, () => dismiss(surface, id));
    },
    [dismiss, slots],
  );

  useEffect(() => {
    for (const [surface, window] of windows) {
      if (window.phase === "active") follow(surface, window);
      else if (window.phase !== "undoing") watchReverse(surface, window);
      if (window.phase === "undo-failed") retireStaleRefusals(surface, window);
    }

    function follow(surface: NoticeSurface, window: Active) {
      const next = window.operation.settlement(view);
      if (next === window.operation) return;
      settle(surface, window.id, (now) =>
        now.phase !== "active" ? now : next && { ...now, operation: next },
      );
    }

    // "Couldn't move X back." names X as the writer last left it; once X is renamed or deleted
    // it describes a row that no longer exists under that name.
    function retireStaleRefusals(
      surface: NoticeSurface,
      window: Extract<NoticeWindow, { phase: "undo-failed" }>,
    ) {
      const stale = window.failed.filter((item) => entryNameNow(view, item.entry) !== item.name);
      if (stale.length === 0) return;
      settle(surface, window.id, (now) => {
        if (now.phase !== "undo-failed") return now;
        const left = now.failed.filter((item) => !stale.includes(item));
        if (left.length > 0) return { ...now, failed: left };
        return now.pending.length > 0
          ? {
              phase: "reversing",
              id: now.id,
              operation: now.operation,
              pending: now.pending,
              refocus: now.refocus,
            }
          : null;
      });
    }

    // Only the server's answer retires a reverse operation: accepted, or overtaken by the
    // writer's next change to the row.
    function watchReverse(
      surface: NoticeSurface,
      window: Extract<NoticeWindow, { phase: "reversing" | "undo-failed" }>,
    ) {
      const { refused, pending } = intentSettlement(view, window.pending);
      if (pending.length === window.pending.length) return;
      settle(surface, window.id, (now) => {
        if (now.phase !== "reversing" && now.phase !== "undo-failed") return now;
        if (refused.length > 0)
          return {
            phase: "undo-failed",
            id: now.id,
            operation: now.operation,
            failed: [
              ...(now.phase === "undo-failed" ? now.failed : []),
              ...refused.map((item) => item.ifRefused),
            ],
            pending,
            refocus: now.refocus,
          };
        if (now.phase === "undo-failed") return { ...now, pending };
        return pending.length > 0 ? { ...now, pending } : null;
      });
    }
  }, [view, windows, settle]);

  const undo = useCallback<OperationNotices["undo"]>(
    async (surface, id) => {
      const window = windows.get(surface);
      if (window?.phase !== "active" || window.id !== id || !window.operation.undoable)
        return false;
      settle(surface, id, (now) =>
        now.phase === "active" ? { phase: "undoing", id, active: now } : now,
      );
      const back = await window.operation.undo({ resources, projectId }).catch(() => null);
      const pending = back?.followed ?? [];
      settle(surface, id, () =>
        !back || back.failed.length > 0
          ? {
              phase: "undo-failed",
              id,
              operation: window.operation,
              failed: back?.failed ?? [],
              pending,
              refocus: window.refocus,
            }
          : pending.length > 0
            ? {
                phase: "reversing",
                id,
                operation: window.operation,
                pending,
                refocus: window.refocus,
              }
            : null,
      );
      return back !== null && back.failed.length === 0;
    },
    [windows, settle, resources, projectId],
  );

  const value = useMemo(
    () => ({ windows, publish, undo, dismiss }),
    [windows, publish, undo, dismiss],
  );
  return (
    <OperationNoticesContext.Provider value={value}>{children}</OperationNoticesContext.Provider>
  );
}

/** Project-owned operation notices, partitioned by their visible surface. */
export function useOperationNotices(): OperationNotices {
  const notices = useContext(OperationNoticesContext);
  if (!notices) throw new Error("OperationNoticesProvider is required");
  return notices;
}

/** Required surface ownership for Move… and Copy to…, with optional behavior from a mounted list. */
export function OperationFeedbackProvider({
  feedback,
  children,
}: {
  feedback: OperationFeedback;
  children: ReactNode;
}) {
  return (
    <OperationFeedbackContext.Provider value={feedback}>
      {children}
    </OperationFeedbackContext.Provider>
  );
}

/** The surface a picker's operation shows on, and how to publish it even when no selectable or focusable list is mounted. */
export function useOperationFeedback() {
  const feedback = useContext(OperationFeedbackContext);
  const notices = useOperationNotices();
  if (!feedback) throw new Error("OperationFeedbackProvider is required");
  const { surface, select, refocus } = feedback;
  const publish = useCallback(
    (operation: Operation) => {
      select?.(operation.rows);
      notices.publish(surface, operation, refocus);
    },
    [surface, select, refocus, notices],
  );
  return { surface, publish };
}

export function OperationNotice({
  surface,
  className,
}: {
  surface: NoticeSurface;
  className?: string;
}) {
  const { windows, undo, dismiss } = useOperationNotices();
  const ref = useRef<HTMLDivElement>(null);
  const window = windows.get(surface);
  const shown = window && present(window);
  if (!window || !shown) return null;
  const { refocus } = shown;
  // Asked before anything awaits: Undo's button disables while it runs and drops focus.
  const holdsFocus = () => ref.current?.contains(document.activeElement) ?? false;
  return (
    <div ref={ref} className="contents">
      <SurfaceNotice
        className={className}
        notice={{
          message: shown.message,
          undoing: shown.undoing,
          undo: shown.undoable
            ? () => {
                const focused = holdsFocus();
                void undo(surface, window.id).then((closed) => {
                  if (closed && focused) refocus?.();
                });
              }
            : null,
          dismiss: () => {
            const focused = holdsFocus();
            dismiss(surface, window.id);
            if (focused) refocus?.();
          },
        }}
      />
    </div>
  );
}

/** What a window shows; null while Undo's reverse operations are out of sight. */
function present(window: NoticeWindow) {
  switch (window.phase) {
    case "active":
    case "undoing": {
      const active = window.phase === "active" ? window : window.active;
      return {
        message: active.operation.message,
        undoable: active.operation.undoable,
        undoing: window.phase === "undoing",
        refocus: active.refocus,
      };
    }
    case "reversing":
      return null;
    case "undo-failed":
      return {
        message: window.operation.describeUndoFailure(window.failed),
        undoable: false,
        undoing: false,
        refocus: window.refocus,
      };
  }
}
