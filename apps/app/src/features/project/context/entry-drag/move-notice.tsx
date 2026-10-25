/**
 * "Moved chapter-3 to Act 2." with Undo, on the surface that took the move (a
 * drop or Move…). One owner per project holds each surface's latest move: its
 * rows, whether Undo still has something to put back (read from the replica,
 * so it needs no list on screen), and Undo itself. The notice shares its
 * surface's one notice place with delete notices (`useNoticeSlot`); a newer
 * notice of either kind replaces it. It stays until then, Dismiss, or leaving
 * the project: Undo is not a race.
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
import { type MoveEffect, planUndo } from "./move-plan";

type MoveWindow = {
  /** Stays with the notice while its message or Undo changes. */
  id: number;
  message: string;
  effects: readonly MoveEffect[];
  /** The replica has shown the move; until then a missing row means "not yet", not "gone". */
  applied: boolean;
  /** Something is still where the move put it. */
  undoable: boolean;
  undoing: boolean;
  /** Puts focus back in a mounted list when the notice leaves under it. */
  refocus?: () => void;
};

type MoveNotices = {
  windows: ReadonlyMap<NoticeSurface, MoveWindow>;
  publish: (
    surface: NoticeSurface,
    result: MoveResult,
    destinationName: string,
    refocus?: () => void,
  ) => void;
  /** Resolves true once every row went back and the notice closed. */
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
      const effects = result.moved;
      setWindows((current) =>
        new Map(current).set(surface, {
          id,
          message: describeMove(result, destinationName),
          effects,
          applied: planUndo(latest.current, effects).length > 0,
          undoable: effects.length > 0,
          undoing: false,
          refocus,
        }),
      );
      slots.take(surface, () => dismiss(surface, id));
    },
    [dismiss, slots],
  );

  // Undo leaves once nothing it would put back is still in place: renamed, moved again or
  // deleted since. The replica can show a move just after it resolves, so it retires only
  // once it has applied and then stops applying.
  useEffect(() => {
    for (const [surface, window] of windows) {
      if (!window.undoable || window.undoing) continue;
      const live = planUndo(projection, window.effects).length > 0;
      if (live && !window.applied) settle(surface, window.id, (now) => ({ ...now, applied: true }));
      else if (!live && window.applied)
        settle(surface, window.id, (now) => ({ ...now, undoable: false }));
    }
  }, [projection, windows, settle]);

  const undo = useCallback<MoveNotices["undo"]>(
    async (surface, id) => {
      const window = windows.get(surface);
      if (window?.id !== id || !window.undoable) return false;
      settle(surface, id, (now) => ({ ...now, undoing: true }));
      const failure = await undoMove(window.effects, { resources, projectId }).then(
        describeUndoFailure,
        () => t`Couldn't move it back.`,
      );
      settle(surface, id, (now) =>
        failure ? { ...now, message: failure, undoable: false, undoing: false } : null,
      );
      return !failure;
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
  if (!window) return null;
  // Asked before anything awaits: Undo's button disables while it runs and drops focus.
  const holdsFocus = () => ref.current?.contains(document.activeElement) ?? false;
  return (
    <div ref={ref} className="contents">
      <SurfaceNotice
        className={className}
        notice={{
          message: window.message,
          undoing: window.undoing,
          undo: window.undoable
            ? () => {
                const focused = holdsFocus();
                void undo(surface, window.id).then((closed) => {
                  if (closed && focused) window.refocus?.();
                });
              }
            : null,
          dismiss: () => {
            const focused = holdsFocus();
            dismiss(surface, window.id);
            if (focused) window.refocus?.();
          },
        }}
      />
    </div>
  );
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

/** Null when every row went back. */
export function describeUndoFailure({ failed }: MoveResult): string | null {
  if (failed.length === 0) return null;
  const [lost] = failed;
  if (failed.length === 1 && lost) return t`Couldn't move ${lost.name} back.`;
  return plural(failed.length, {
    one: "Couldn't move # item back.",
    other: "Couldn't move # items back.",
  });
}
