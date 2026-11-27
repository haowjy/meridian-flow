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
import { clearDragHint, showDragHint } from "@/core/editor/landing/drag-hint-store";
import { type DragPayloadKind, dragPayloadKind } from "@/core/editor/landing/drag-payload";
import { captureDrop, type DroppedItems } from "@/lib/dropped-items";

export type TreeDropTarget = {
  scheme: ProjectContextTreeScheme;
  treeRootId: string;
  folder: { entryId: string; path: string; uri: string; name: string } | null;
  position?: ContextSiblingPosition;
};

export type EntriesVerdict = { kind: "accept" | "refuse"; label: string };

export type EntriesRoute = {
  verdict(target: TreeDropTarget): EntriesVerdict | null;
  drop(target: TreeDropTarget, point: { x: number; y: number }): void;
};

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
  enter(
    key: string,
    target: TreeDropTarget,
    refused: boolean,
    reveal: (() => void) | undefined,
  ): void;
  relight(key: string, target: TreeDropTarget, refused: boolean): void;
  leave(key: string): void;
  generation(): number;
};

const ScopeContext = createContext<ScopeValue | null>(null);

export function treeDropTargetKey(target: TreeDropTarget): string {
  return `${target.scheme}:${target.folder?.entryId ?? target.treeRootId}:${JSON.stringify(target.position)}`;
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

const claimed = new WeakSet<Event>();

export type RowEdges = {
  folder: TreeDropTarget["folder"];
  siblingId: string;
  band: number;
  after: boolean;
};

export type DropEdge = "before" | "after";

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
    treeRootId: target.treeRootId,
    folder: edges.folder,
    position: { kind, siblingId: edges.siblingId },
  };
}

export function useTreeDropTarget(
  target: TreeDropTarget,
  options: { reveal?: () => void; edges?: RowEdges } = {},
): { dropProps: DropProps; dropState: TreeDropState; edge: DropEdge | null } {
  const scope = useContext(ScopeContext);
  const key = treeDropTargetKey(target);
  const held = useRef<{ generation: number; key: string } | null>(null);
  const latest = useRef({ target, scope, ...options });
  latest.current = { target, scope, ...options };

  const claim = useCallback((event: DragEvent): DragPayloadKind | null => {
    if (!latest.current.scope || claimed.has(event.nativeEvent)) return null;
    const kind = dragPayloadKind(Array.from(event.dataTransfer?.types ?? []));
    if (kind === "none" || !latest.current.scope.routes[kind]) return null;
    claimed.add(event.nativeEvent);
    return kind;
  }, []);

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
