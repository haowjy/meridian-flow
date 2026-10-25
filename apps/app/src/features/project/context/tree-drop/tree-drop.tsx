/**
 * The one drop dispatcher on the project tree. Rows dragged inside the app
 * (`entries`) have a route; the route decides, this file only dispatches,
 * lights the target and says what the drop will do. Desktop file drops arrive
 * with import.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import {
  createContext,
  type DragEvent,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { captureDrop, type DroppedItems } from "@/lib/dropped-items";
import { clearDragHint, showDragHint } from "./drag-hint";
import { dragPayloadKind } from "./drag-payload";

export type TreeDropTarget = {
  scheme: ProjectContextTreeScheme;
  /** The catalog the target belongs to; one list can show several (a chat's Scratch and its earlier notes). */
  catalogRootId: string;
  /** The folder row, or null for the catalog's top level (the area header). */
  folder: { entryId: string; path: string; uri: string; name: string } | null;
};

/**
 * What dropping an internal payload on a target would do. `accept` lights the
 * target and allows the drop; `refuse` leaves it unlit with the no-drop cursor and says why. A
 * null verdict leaves the target quiet (the drop would change nothing). An
 * accept's `warning` says what the drop will also do that the writer may not
 * expect (rows arriving renamed), while there is still time to let go elsewhere.
 */
export type EntriesVerdict =
  | { kind: "accept"; label: string; warning?: string | null }
  | { kind: "refuse"; label: string };

export type EntriesRoute = {
  verdict(target: TreeDropTarget): EntriesVerdict | null;
  drop(target: TreeDropTarget): void;
};

export type FilesRoute = {
  accepts(target: TreeDropTarget): boolean;
  drop(target: TreeDropTarget, items: DroppedItems): void;
};

export type TreeDropRoutes = {
  entries?: EntriesRoute;
  files?: FilesRoute;
};

export type TreeDropState = "idle" | "over" | "refused";

const SPRING_MS = 600;

type Over = { key: string; refused: boolean } | null;

type ScopeValue = {
  routes: TreeDropRoutes;
  over: Over;
  /** An element of `key` came under the drag; arms the spring for an accepted target. */
  enter(key: string, refused: boolean, reveal: (() => void) | undefined): void;
  /** Re-lights `key` on every `dragover` (its verdict can change while hovering). */
  relight(key: string, refused: boolean): void;
  /** An element of `key` left; the target goes dark once none remain. */
  leave(key: string): void;
  /** Bumps when a drag ends anywhere; holds from an earlier drag are void. */
  generation(): number;
};

const ScopeContext = createContext<ScopeValue | null>(null);

function targetKey(target: TreeDropTarget): string {
  return `${target.scheme}:${target.folder?.entryId ?? target.catalogRootId}`;
}

/**
 * Holds the route and the one lit target for a list. A folder row and every
 * row inside it share one target: the next row's `dragenter` arrives before the
 * last one's `dragleave`, so a per-target count, not any single element,
 * decides when the target goes dark. Counts, the lit target and spring timers
 * end together when a drag ends anywhere (Escape, a drop elsewhere).
 */
export function TreeDropScope({
  routes,
  children,
}: {
  routes: TreeDropRoutes;
  children: ReactNode;
}) {
  const [over, setOver] = useState<Over>(null);
  const counts = useRef(new Map<string, number>());
  const springs = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const generation = useRef(0);

  const scope = useMemo(() => {
    const stopSpring = (key: string) => {
      const timer = springs.current.get(key);
      if (timer) clearTimeout(timer);
      springs.current.delete(key);
    };
    return {
      enter(key: string, refused: boolean, reveal: (() => void) | undefined) {
        counts.current.set(key, (counts.current.get(key) ?? 0) + 1);
        setOver({ key, refused });
        if (!refused && reveal && !springs.current.has(key))
          springs.current.set(
            key,
            setTimeout(() => {
              springs.current.delete(key);
              reveal();
            }, SPRING_MS),
          );
      },
      relight(key: string, refused: boolean) {
        setOver((current) =>
          current?.key === key && current.refused === refused ? current : { key, refused },
        );
        if (refused) stopSpring(key);
      },
      leave(key: string) {
        const next = (counts.current.get(key) ?? 0) - 1;
        if (next > 0) {
          counts.current.set(key, next);
          return;
        }
        counts.current.delete(key);
        stopSpring(key);
        clearDragHint(key);
        setOver((current) => (current?.key === key ? null : current));
      },
      end() {
        generation.current += 1;
        counts.current.clear();
        for (const timer of springs.current.values()) clearTimeout(timer);
        springs.current.clear();
        setOver(null);
      },
      generation: () => generation.current,
    };
  }, []);

  useEffect(() => {
    window.addEventListener("dragend", scope.end);
    window.addEventListener("drop", scope.end);
    return () => {
      window.removeEventListener("dragend", scope.end);
      window.removeEventListener("drop", scope.end);
      scope.end();
    };
  }, [scope]);

  const value = useMemo<ScopeValue>(() => ({ routes, over, ...scope }), [routes, over, scope]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

type DropProps = Pick<
  HTMLAttributes<HTMLElement>,
  "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop"
>;

const NO_PROPS: DropProps = {};

/**
 * Targets nest (a row inside its group): the innermost one with a route for the
 * payload claims each event, even when its answer is "nothing", so an outer
 * target never takes over (or counts down) a drag its rows chose to ignore.
 */
const claimed = new WeakSet<Event>();

/**
 * Drop handlers for one target. A file row passes its folder as the target, so
 * hovering anywhere in an open folder lights that folder. Each element remembers
 * whether it lit its target, so it always gives that back on leave, whatever
 * the verdict is by then. `reveal` shows what the target holds (a collapsed
 * folder opens): after hovering an accepted target for 600 ms, and on its drop,
 * so the rows that arrived are in view.
 */
export function useTreeDropTarget(
  target: TreeDropTarget,
  options: { reveal?: () => void } = {},
): { dropProps: DropProps; dropState: TreeDropState } {
  const scope = useContext(ScopeContext);
  const key = targetKey(target);
  const held = useRef<{ generation: number } | null>(null);
  const latest = useRef({ target, scope, reveal: options.reveal });
  latest.current = { target, scope, reveal: options.reveal };

  /** Claims the event for this target when the scope owns the payload's route. */
  const claim = useCallback((event: DragEvent): "entries" | "files" | null => {
    if (!latest.current.scope || claimed.has(event.nativeEvent)) return null;
    const kind = dragPayloadKind(Array.from(event.dataTransfer?.types ?? []));
    if (kind === "none" || !latest.current.scope.routes[kind]) return null;
    claimed.add(event.nativeEvent);
    return kind;
  }, []);

  const verdictFor = useCallback((): EntriesVerdict | null => {
    const { target: current, scope: currentScope } = latest.current;
    return currentScope?.routes.entries?.verdict(current) ?? null;
  }, []);

  const holding = useCallback(() => {
    const currentScope = latest.current.scope;
    return held.current !== null && held.current.generation === currentScope?.generation();
  }, []);

  const release = useCallback(() => {
    if (!holding()) return;
    held.current = null;
    latest.current.scope?.leave(key);
  }, [holding, key]);

  const show = useCallback(
    (event: DragEvent, verdict: EntriesVerdict) => {
      const currentScope = latest.current.scope;
      if (!currentScope) return;
      const refused = verdict.kind === "refuse";
      if (!holding()) {
        held.current = { generation: currentScope.generation() };
        currentScope.enter(key, refused, latest.current.reveal);
      } else currentScope.relight(key, refused);
      showDragHint(key, verdict, event);
      if (refused) {
        event.dataTransfer.dropEffect = "none";
        return;
      }
      // Only an accepted target cancels the default; a refused one keeps the no-drop cursor.
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [holding, key],
  );

  const hover = useCallback(
    (event: DragEvent) => {
      const kind = claim(event);
      if (!kind) return;
      const verdict =
        kind === "entries"
          ? verdictFor()
          : latest.current.scope?.routes.files?.accepts(latest.current.target)
            ? ({ kind: "accept", label: "" } satisfies EntriesVerdict)
            : null;
      if (verdict) {
        show(event, verdict);
        if (kind === "files") event.dataTransfer.dropEffect = "copy";
      }
      // The verdict went quiet while hovering: give the target back.
      else release();
    },
    [claim, verdictFor, show, release],
  );

  useEffect(() => release, [release]);

  const dropProps = useMemo<DropProps>(
    () => ({
      onDragEnter: hover,
      // A drag that began inside this target never fires `dragenter` here.
      onDragOver: hover,
      onDragLeave(event) {
        if (claim(event)) release();
      },
      onDrop(event) {
        const kind = claim(event);
        if (!kind) return;
        const verdict =
          kind === "entries"
            ? verdictFor()
            : latest.current.scope?.routes.files?.accepts(latest.current.target)
              ? ({ kind: "accept", label: "" } satisfies EntriesVerdict)
              : null;
        release();
        if (!verdict || verdict.kind === "refuse") return;
        event.preventDefault();
        event.stopPropagation();
        const { scope: currentScope, target: dropped } = latest.current;
        if (kind === "entries") currentScope?.routes.entries?.drop(dropped);
        else currentScope?.routes.files?.drop(dropped, captureDrop(event.dataTransfer));
        latest.current.reveal?.();
      },
    }),
    [hover, claim, verdictFor, release],
  );

  if (!scope) return { dropProps: NO_PROPS, dropState: "idle" };
  const lit = scope.over?.key === key;
  return {
    dropProps,
    dropState: !lit ? "idle" : scope.over?.refused ? "refused" : "over",
  };
}

/** Prevents an unclaimed desktop file drop from navigating the browser away. */
export function useWindowDropGuard() {
  useEffect(() => {
    const guard = (event: globalThis.DragEvent) => {
      if (event.defaultPrevented) return;
      if (dragPayloadKind(Array.from(event.dataTransfer?.types ?? [])) !== "files") return;
      event.preventDefault();
      if (event.dataTransfer && event.type === "dragover") event.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);
}

const EDGE_PX = 32;
const SCROLL_STEP_PX = 14;

/** Scrolls a container while a drag is within 32 px of its top or bottom. */
export function dragEdgeScroll(container: HTMLElement | null, event: DragEvent) {
  if (!container) return;
  if (dragPayloadKind(Array.from(event.dataTransfer?.types ?? [])) === "none") return;
  const rect = container.getBoundingClientRect();
  if (event.clientY < rect.top + EDGE_PX) container.scrollTop -= SCROLL_STEP_PX;
  else if (event.clientY > rect.bottom - EDGE_PX) container.scrollTop += SCROLL_STEP_PX;
}
