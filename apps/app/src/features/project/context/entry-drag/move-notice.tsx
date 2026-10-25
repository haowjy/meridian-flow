/**
 * "Moved chapter-3 to Act 2." with Undo, on the surface that took the move (a
 * drop or Move…). One owner per project holds each surface's latest move: its
 * rows, which of them the server refused since, whether Undo still has
 * something to put back (both read from the replica, so it needs no list on
 * screen), and Undo itself. The notice shares its
 * surface's one notice place with delete notices (`useNoticeSlot`); a newer
 * notice of either kind replaces it. It stays until then, Dismiss, or leaving
 * the project: Undo is not a race. After Undo the notice leaves at once but
 * its surface keeps watching the reverse moves, off screen, until the server
 * answers each, so a refused Undo comes back as "Couldn't move X back.".
 */
import { plural, t } from "@lingui/core/macro";
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
import { type MoveResult, undoMove } from "./execute-move";
import { type MoveEffect, moveSettlement, planUndo } from "./move-plan";

type Failure = MoveResult["failed"][number];

/**
 * One surface's latest move, by phase. Only `moved` offers Undo, and only
 * `reversing` is off screen; what the notice says follows from the phase.
 */
type MoveWindow =
  | {
      phase: "moved";
      /** Stays with the notice through every phase, so a stale answer can't touch a newer one. */
      id: number;
      /** What the move did, kept current as the server refuses rows. */
      result: MoveResult;
      destinationName: string;
      /** The moves the server has not settled yet; refusals are looked for only here. */
      unsettled: readonly MoveEffect[];
      /** The replica has shown the move; until then a missing row means "not yet", not "gone". */
      applied: boolean;
      /** Something is still where the move put it. */
      undoable: boolean;
      /** Puts focus back in a mounted list when the notice leaves under it. */
      refocus?: () => void;
    }
  /** The replica is admitting Undo's reverse moves; the notice stays, its Undo disabled. */
  | { phase: "undoing"; id: number; move: Extract<MoveWindow, { phase: "moved" }> }
  /** Undo closed the notice; it comes back only if the server refuses one of `pending`. */
  | { phase: "reversing"; id: number; pending: readonly MoveEffect[]; refocus?: () => void }
  /**
   * Rows Undo could not put back, the replica's refusals and the server's
   * together; no `failed` means Undo threw before naming any. Still watches
   * the rest of its reverse moves, which can only add to the count.
   */
  | {
      phase: "undo-failed";
      id: number;
      failed: readonly Failure[];
      pending: readonly MoveEffect[];
      refocus?: () => void;
    };

type MovedWindow = Extract<MoveWindow, { phase: "moved" }>;

type MoveNotices = {
  windows: ReadonlyMap<NoticeSurface, MoveWindow>;
  publish: (
    surface: NoticeSurface,
    result: MoveResult,
    destinationName: string,
    refocus?: () => void,
  ) => void;
  /**
   * Resolves true once the replica took every row back and the notice closed;
   * the notice returns if the server then refuses one.
   */
  undo: (surface: NoticeSurface, id: number) => Promise<boolean>;
  dismiss: (surface: NoticeSurface, id: number) => void;
};

const MoveNoticesContext = createContext<MoveNotices | null>(null);

type MoveFeedback = {
  surface: NoticeSurface;
  select?: (result: MoveResult) => void;
  refocus?: () => void;
};

const MoveFeedbackContext = createContext<MoveFeedback | null>(null);

let nextNoticeId = 1;

export function MoveNoticesProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const resources = useAccountResourceReplica();
  const projection = useAccountResourceProjection(projectId);
  const slots = useNoticeSlot();
  const [windows, setWindows] = useState<ReadonlyMap<NoticeSurface, MoveWindow>>(() => new Map());
  const latest = useRef(projection);
  latest.current = projection;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Replaces or clears notice `id`, unless a newer one has taken its surface. */
  const settle = useCallback(
    (surface: NoticeSurface, id: number, next: (now: MoveWindow) => MoveWindow | null) => {
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

  const publish = useCallback<MoveNotices["publish"]>(
    (surface, result, destinationName, refocus) => {
      // A move can finish after its project has gone; there is nowhere to say so.
      if (!mounted.current) return;
      const id = nextNoticeId++;
      setWindows((current) =>
        new Map(current).set(surface, {
          phase: "moved",
          id,
          result,
          destinationName,
          unsettled: result.moved.filter((effect) => effect.operationId),
          applied: planUndo(latest.current, result.moved).length > 0,
          undoable: result.moved.length > 0,
          refocus,
        }),
      );
      slots.take(surface, () => dismiss(surface, id));
    },
    [dismiss, slots],
  );

  useEffect(() => {
    for (const [surface, window] of windows) {
      if (window.phase === "moved") watchMove(surface, window);
      else if (window.phase !== "undoing") watchReverse(surface, window);
    }

    // A row the server refused went back to its source with its failure mark; the notice
    // stops claiming it moved. Undo leaves once nothing it would put back is still in place:
    // refused, renamed, moved again or deleted since. The replica can show a move just after
    // it resolves, so it retires only once it has applied and then stops applying.
    function watchMove(surface: NoticeSurface, window: MovedWindow) {
      const { refused, pending } = moveSettlement(projection, window.unsettled);
      if (refused.length > 0) {
        const gone = new Set(refused);
        settle(surface, window.id, (now) => {
          if (now.phase !== "moved") return now;
          const moved = now.result.moved.filter((effect) => !gone.has(effect));
          return {
            ...now,
            result: { moved, failed: [...now.result.failed, ...wentBack(refused)] },
            unsettled: pending,
            undoable: now.undoable && moved.length > 0,
          };
        });
        return;
      }
      if (pending.length < window.unsettled.length)
        settle(surface, window.id, (now) =>
          now.phase === "moved" ? { ...now, unsettled: pending } : now,
        );
      if (!window.undoable) return;
      const live = planUndo(projection, window.result.moved).length > 0;
      if (live !== window.applied)
        settle(surface, window.id, (now) =>
          now.phase !== "moved"
            ? now
            : live
              ? { ...now, applied: true }
              : { ...now, undoable: false },
        );
    }

    // Only the server's answer retires a reverse move: accepted, or overtaken by the
    // writer's next change to the row.
    function watchReverse(
      surface: NoticeSurface,
      window: Extract<MoveWindow, { phase: "reversing" | "undo-failed" }>,
    ) {
      const { refused, pending } = moveSettlement(projection, window.pending);
      if (pending.length === window.pending.length) return;
      settle(surface, window.id, (now) => {
        if (now.phase !== "reversing" && now.phase !== "undo-failed") return now;
        if (refused.length > 0)
          return {
            phase: "undo-failed",
            id: now.id,
            failed: [...(now.phase === "undo-failed" ? now.failed : []), ...wentBack(refused)],
            pending,
            refocus: now.refocus,
          };
        if (now.phase === "undo-failed") return { ...now, pending };
        return pending.length > 0 ? { ...now, pending } : null;
      });
    }
  }, [projection, windows, settle]);

  const undo = useCallback<MoveNotices["undo"]>(
    async (surface, id) => {
      const window = windows.get(surface);
      if (window?.phase !== "moved" || window.id !== id || !window.undoable) return false;
      settle(surface, id, (now) =>
        now.phase === "moved" ? { phase: "undoing", id, move: now } : now,
      );
      const back = await undoMove(window.result.moved, { resources, projectId }).catch(() => null);
      const pending = back?.moved.filter((effect) => effect.operationId) ?? [];
      settle(surface, id, () =>
        !back || back.failed.length > 0
          ? {
              phase: "undo-failed",
              id,
              failed: back?.failed ?? [],
              pending,
              refocus: window.refocus,
            }
          : pending.length > 0
            ? { phase: "reversing", id, pending, refocus: window.refocus }
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
  return <MoveNoticesContext.Provider value={value}>{children}</MoveNoticesContext.Provider>;
}

/** Project-owned move notices, partitioned by their visible surface. */
export function useMoveNotices(): MoveNotices {
  const notices = useContext(MoveNoticesContext);
  if (!notices) throw new Error("MoveNoticesProvider is required");
  return notices;
}

/** Required surface ownership for Move…, with optional behavior from a mounted list. */
export function MoveFeedbackProvider({
  feedback,
  children,
}: {
  feedback: MoveFeedback;
  children: ReactNode;
}) {
  return <MoveFeedbackContext.Provider value={feedback}>{children}</MoveFeedbackContext.Provider>;
}

/** Publishes Move… feedback even when no selectable or focusable list is mounted. */
export function usePublishMove() {
  const feedback = useContext(MoveFeedbackContext);
  const notices = useMoveNotices();
  if (!feedback) throw new Error("MoveFeedbackProvider is required");
  return useCallback(
    (result: MoveResult, destinationName: string) => {
      feedback.select?.(result);
      notices.publish(feedback.surface, result, destinationName, feedback.refocus);
    },
    [feedback, notices],
  );
}

export function MoveNotice({ surface, className }: { surface: NoticeSurface; className?: string }) {
  const { windows, undo, dismiss } = useMoveNotices();
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

/** What a window shows; null while Undo's reverse moves are out of sight. */
function present(window: MoveWindow) {
  switch (window.phase) {
    case "moved":
    case "undoing": {
      const move = window.phase === "moved" ? window : window.move;
      return {
        message: describeMove(move.result, move.destinationName),
        undoable: move.undoable,
        undoing: window.phase === "undoing",
        refocus: move.refocus,
      };
    }
    case "reversing":
      return null;
    case "undo-failed":
      return {
        message: describeUndoFailure(window.failed) ?? t`Couldn't move it back.`,
        undoable: false,
        undoing: false,
        refocus: window.refocus,
      };
  }
}

/**
 * "Moved 3 items to Act 2." and, when the replica refused some, which. A lone
 * row that arrived under the next free name says so.
 */
export function describeMove(result: MoveResult, destinationName: string): string {
  const { moved, failed } = result;
  const parts: string[] = [];
  const [first] = moved;
  if (moved.length === 1 && first && first.previousName !== first.name)
    parts.push(t`Moved ${first.previousName} to ${destinationName} as ${first.name}.`);
  else if (moved.length === 1 && first) parts.push(t`Moved ${first.name} to ${destinationName}.`);
  else if (moved.length > 1)
    parts.push(
      plural(moved.length, {
        one: `Moved # item to ${destinationName}.`,
        other: `Moved # items to ${destinationName}.`,
      }),
    );
  const [lost] = failed;
  if (failed.length === 1 && lost) parts.push(t`Couldn't move ${lost.name}.`);
  else if (failed.length > 1)
    parts.push(
      plural(failed.length, { one: "Couldn't move # item.", other: "Couldn't move # items." }),
    );
  return parts.join(" ");
}

/** The warning before a move whose rows would arrive renamed; null when none would. */
export function describeRenames(renamed: readonly { name: string; as: string }[]): string | null {
  const [only] = renamed;
  if (!only) return null;
  if (renamed.length === 1) return t`${only.name} will be renamed ${only.as}`;
  return plural(renamed.length, {
    one: "# item will be renamed",
    other: "# items will be renamed",
  });
}

/** A refused row went back where it came from, under its name there. */
function wentBack(effects: readonly MoveEffect[]) {
  return effects.map((effect) => ({ entry: effect.entry, name: effect.previousName }));
}

/** Null when every row went back. */
export function describeUndoFailure(failed: readonly Failure[]): string | null {
  if (failed.length === 0) return null;
  const [lost] = failed;
  if (failed.length === 1 && lost) return t`Couldn't move ${lost.name} back.`;
  return plural(failed.length, {
    one: "Couldn't move # item back.",
    other: "Couldn't move # items back.",
  });
}
