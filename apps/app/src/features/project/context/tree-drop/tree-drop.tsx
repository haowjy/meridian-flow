/**
 * The one drop dispatcher on the project tree. Rows dragged inside the app
 * (`entries`) have a route; the route decides, this file only dispatches,
 * lights the target and says what the drop will do. Desktop files (`files`)
 * have their own route: they always import into the row's folder, never at an
 * edge position.
 */
import type {
  ContextSiblingPosition,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
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
import { type DragPayloadKind, dragPayloadKind } from "./drag-payload";

export type TreeDropTarget = {
  scheme: ProjectContextTreeScheme;
  /** The catalog the target belongs to; one list can show several (a chat's Scratch and its earlier notes). */
  catalogRootId: string;
  /** The folder row, or null for the catalog's top level (the area header). */
  folder: { entryId: string; path: string; uri: string; name: string } | null;
  /** A sibling edge; absent while the folder/container region owns the target. */
  position?: ContextSiblingPosition;
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
  /** `point` is where the pointer let go, in client coordinates, for a route that asks at the drop. */
  drop(target: TreeDropTarget, point: { x: number; y: number }): void;
};

/** Desktop files: the verdict is `EntriesVerdict`'s shape too, so the hint says what the drop will do. */
export type FilesRoute = {
  verdict(target: TreeDropTarget): EntriesVerdict | null;
  drop(target: TreeDropTarget, items: DroppedItems): void;
};

export type TreeDropRoutes = {
  entries?: EntriesRoute;
  files?: FilesRoute;
};

export type TreeDropState = "idle" | "over" | "refused";

const SPRING_MS = 600;

type Over = { key: string; refused: boolean; target: TreeDropTarget } | null;

type ScopeValue = {
  routes: TreeDropRoutes;
  over: Over;
  /** An element of `key` came under the drag; arms the spring for an accepted target. */
  enter(
    key: string,
    target: TreeDropTarget,
    refused: boolean,
    reveal: (() => void) | undefined,
  ): void;
  /** Re-lights `key` on every `dragover` (its verdict can change while hovering). */
  relight(key: string, target: TreeDropTarget, refused: boolean): void;
  /** An element of `key` left; the target goes dark once none remain. */
  leave(key: string): void;
  /** Bumps when a drag ends anywhere; holds from an earlier drag are void. */
  generation(): number;
};

const ScopeContext = createContext<ScopeValue | null>(null);

/** One key per distinct target: catalog, folder and, for an edge, its side and anchor. */
export function treeDropTargetKey(target: TreeDropTarget): string {
  return `${target.scheme}:${target.folder?.entryId ?? target.catalogRootId}:${JSON.stringify(target.position)}`;
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
      enter(
        key: string,
        target: TreeDropTarget,
        refused: boolean,
        reveal: (() => void) | undefined,
      ) {
        counts.current.set(key, (counts.current.get(key) ?? 0) + 1);
        setOver({ key, refused, target });
        if (!refused && reveal && !springs.current.has(key))
          springs.current.set(
            key,
            setTimeout(() => {
              springs.current.delete(key);
              reveal();
            }, SPRING_MS),
          );
      },
      relight(key: string, target: TreeDropTarget, refused: boolean) {
        setOver((current) =>
          current?.key === key && current.refused === refused ? current : { key, refused, target },
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
 * A row's top and bottom bands are sibling edges: before or after `siblingId`
 * in the row's actual parent (`folder`). `band` is each edge's share of the
 * row's height; `after` is false for an open folder, whose bottom borders its
 * own first child rather than its next sibling.
 */
export type RowEdges = {
  folder: TreeDropTarget["folder"];
  siblingId: string;
  band: number;
  after: boolean;
};

export type DropEdge = "before" | "after";

/** The target under the pointer: an edge when it is in an edge band, otherwise the row's own target. */
function targetAt(target: TreeDropTarget, edges: RowEdges | undefined, event: DragEvent) {
  if (!edges) return target;
  const rect = event.currentTarget.getBoundingClientRect();
  const y = event.clientY - rect.top;
  const band = rect.height * edges.band;
  const kind: DropEdge | null =
    y < band ? "before" : edges.after && y > rect.height - band ? "after" : null;
  if (!kind) return target;
  return {
    scheme: target.scheme,
    catalogRootId: target.catalogRootId,
    folder: edges.folder,
    position: { kind, siblingId: edges.siblingId },
  };
}

/**
 * Drop handlers for one row or region. A file row passes its folder as the
 * target, so hovering anywhere in an open folder lights that folder; with
 * `edges`, the row's top and bottom bands are sibling positions instead, and
 * each event resolves to exactly one target. An edge claims its event even
 * when its answer is "nothing", so the folder region under it never takes
 * over. An element holds at most one target at a time and always gives that
 * one back (moving from one edge to the other releases the first and its
 * spring at once, without waiting for `dragleave`), whatever its verdict is
 * by then. `reveal` shows what the row's own target holds (a collapsed folder
 * opens): after hovering it accepted for 600 ms, and on its drop, so the rows
 * that arrived are in view. Edges don't spring.
 */
export function useTreeDropTarget(
  target: TreeDropTarget,
  options: { reveal?: () => void; edges?: RowEdges } = {},
): { dropProps: DropProps; dropState: TreeDropState; edge: DropEdge | null } {
  const scope = useContext(ScopeContext);
  const key = treeDropTargetKey(target);
  const held = useRef<{ generation: number; key: string } | null>(null);
  const latest = useRef({ target, scope, ...options });
  latest.current = { target, scope, ...options };

  /** Claims the event for this element when the scope owns the payload's route. */
  const claim = useCallback((event: DragEvent): DragPayloadKind | null => {
    if (!latest.current.scope || claimed.has(event.nativeEvent)) return null;
    const kind = dragPayloadKind(Array.from(event.dataTransfer?.types ?? []));
    if (kind === "none" || !latest.current.scope.routes[kind]) return null;
    claimed.add(event.nativeEvent);
    return kind;
  }, []);

  /** Files ignore edges: an edge band is the row's own folder, so an import never takes a sibling position. */
  const resolve = useCallback((event: DragEvent, kind: DragPayloadKind) => {
    const { target: own, edges } = latest.current;
    const current = kind === "entries" ? targetAt(own, edges, event) : own;
    return { target: current, key: treeDropTargetKey(current) };
  }, []);

  const verdictFor = useCallback(
    (kind: DragPayloadKind, current: TreeDropTarget): EntriesVerdict | null => {
      const routes = latest.current.scope?.routes;
      return (kind === "entries" ? routes?.entries : routes?.files)?.verdict(current) ?? null;
    },
    [],
  );

  const holding = useCallback((): string | null => {
    const currentScope = latest.current.scope;
    return held.current && held.current.generation === currentScope?.generation()
      ? held.current.key
      : null;
  }, []);

  const release = useCallback(() => {
    const heldKey = holding();
    held.current = null;
    if (heldKey) latest.current.scope?.leave(heldKey);
  }, [holding]);

  const show = useCallback(
    (
      event: DragEvent,
      kind: DragPayloadKind,
      current: { target: TreeDropTarget; key: string },
      verdict: EntriesVerdict,
    ) => {
      const currentScope = latest.current.scope;
      if (!currentScope) return;
      const refused = verdict.kind === "refuse";
      if (holding() !== current.key) {
        release();
        held.current = { generation: currentScope.generation(), key: current.key };
        const reveal = current.target.position ? undefined : latest.current.reveal;
        currentScope.enter(current.key, current.target, refused, reveal);
      } else currentScope.relight(current.key, current.target, refused);
      showDragHint(current.key, verdict, event);
      if (refused) {
        event.dataTransfer.dropEffect = "none";
        return;
      }
      // Only an accepted target cancels the default; a refused one keeps the no-drop cursor.
      event.preventDefault();
      event.dataTransfer.dropEffect = kind === "files" ? "copy" : "move";
    },
    [holding, release],
  );

  const hover = useCallback(
    (event: DragEvent) => {
      const kind = claim(event);
      if (!kind) return;
      const current = resolve(event, kind);
      const verdict = verdictFor(kind, current.target);
      if (verdict) show(event, kind, current, verdict);
      // The verdict went quiet while hovering (or the pointer reached a quiet edge): give the target back.
      else release();
    },
    [claim, resolve, verdictFor, show, release],
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
        const { target: dropped } = resolve(event, kind);
        const verdict = verdictFor(kind, dropped);
        release();
        if (!verdict || verdict.kind === "refuse") return;
        event.preventDefault();
        event.stopPropagation();
        const routes = latest.current.scope?.routes;
        if (kind === "entries")
          routes?.entries?.drop(dropped, { x: event.clientX, y: event.clientY });
        else routes?.files?.drop(dropped, captureDrop(event.dataTransfer));
        if (!dropped.position) latest.current.reveal?.();
      },
    }),
    [hover, claim, resolve, verdictFor, release],
  );

  if (!scope) return { dropProps: NO_PROPS, dropState: "idle", edge: null };
  const over = scope.over;
  const lit = over?.key === key;
  const position = over && !over.refused ? over.target.position : undefined;
  const edge =
    position && "siblingId" in position && position.siblingId === options.edges?.siblingId
      ? (position.kind as DropEdge)
      : null;
  return {
    dropProps,
    dropState: !lit ? "idle" : over?.refused ? "refused" : "over",
    edge,
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
