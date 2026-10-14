/**
 * The one drop dispatcher on the project tree. Payloads from the desktop
 * (`Files`) go to import; internal payloads (`entries`) are rows dragged inside
 * the app. Each kind has a route; the routes decide, this file only dispatches,
 * lights the target and says what the drop will do.
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
  /** The folder row, or null for the area root (the header). */
  folder: { entryId: string; path: string; uri: string; name: string } | null;
};

/**
 * What dropping an internal payload on a target would do. `accept` lights the
 * target and allows the drop; `refuse` lights it as refused and says why. A
 * null verdict leaves the target quiet (the drop would change nothing).
 */
export type EntriesVerdict = { kind: "accept" | "refuse"; label: string };

export type TreeDropRoutes = {
  files?: {
    accepts(target: TreeDropTarget): boolean;
    drop(target: TreeDropTarget, items: DroppedItems): void;
  };
  entries?: {
    verdict(target: TreeDropTarget): EntriesVerdict | null;
    drop(target: TreeDropTarget): void;
  };
};

export type TreeDropState = "idle" | "over" | "refused";

const SPRING_MS = 600;

type Over = { key: string; refused: boolean } | null;

type ScopeValue = {
  routes: TreeDropRoutes;
  over: Over;
  setOver(over: Over): void;
  /** Counts elements under the drag per target; returns the count after the change. */
  count(key: string, delta: 1 | -1 | "reset"): number;
};

const ScopeContext = createContext<ScopeValue | null>(null);

export function targetKey(target: TreeDropTarget): string {
  return `${target.scheme}:${target.folder?.entryId ?? "root"}`;
}

/** Holds the routes and the one lit target for an area's header and rows. */
export function TreeDropScope({
  routes,
  children,
}: {
  routes: TreeDropRoutes;
  children: ReactNode;
}) {
  const [over, setOver] = useState<Over>(null);
  // A folder row and every row inside it share one target: the next row's
  // `dragenter` arrives before the last one's `dragleave`, so the count, not
  // any single element, decides when the target goes dark.
  const counts = useRef(new Map<string, number>());
  const count = useCallback((key: string, delta: 1 | -1 | "reset") => {
    const next = delta === "reset" ? 0 : Math.max(0, (counts.current.get(key) ?? 0) + delta);
    if (next === 0) counts.current.delete(key);
    else counts.current.set(key, next);
    if (next === 0) setOver((current) => (current?.key === key ? null : current));
    return next;
  }, []);
  // A drag cancelled with Escape or dropped elsewhere may skip the last `dragleave`.
  useEffect(() => {
    const reset = () => {
      counts.current.clear();
      setOver(null);
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, []);
  const value = useMemo(() => ({ routes, over, setOver, count }), [routes, over, count]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

type DropProps = Pick<
  HTMLAttributes<HTMLElement>,
  "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop"
>;

const NO_PROPS: DropProps = {};

type Engagement = { kind: "files"; label: null } | { kind: "entries"; verdict: EntriesVerdict };

/**
 * Drop handlers for one target. A file row passes its folder as the target, so
 * hovering anywhere in an open folder lights that folder. `dragenter` and
 * `dragleave` are counted so moving over a child does not flicker. Hovering an
 * accepted target for 600 ms calls `onSpring` (a collapsed folder opens).
 */
export function useTreeDropTarget(
  target: TreeDropTarget,
  options: { onSpring?: () => void } = {},
): { dropProps: DropProps; dropState: TreeDropState } {
  const scope = useContext(ScopeContext);
  const key = targetKey(target);
  const spring = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ target, scope, onSpring: options.onSpring });
  latest.current = { target, scope, onSpring: options.onSpring };

  const stopSpring = useCallback(() => {
    if (spring.current) clearTimeout(spring.current);
    spring.current = undefined;
  }, []);
  useEffect(() => stopSpring, [stopSpring]);

  const engage = useCallback((event: DragEvent): Engagement | null => {
    const { target: current, scope: currentScope } = latest.current;
    if (!currentScope) return null;
    const kind = dragPayloadKind(Array.from(event.dataTransfer?.types ?? []));
    if (kind === "files" && currentScope.routes.files?.accepts(current))
      return { kind: "files", label: null };
    if (kind === "entries") {
      const verdict = currentScope.routes.entries?.verdict(current);
      if (verdict) return { kind: "entries", verdict };
    }
    return null;
  }, []);

  const light = useCallback(
    (event: DragEvent, engagement: Engagement) => {
      const refused = engagement.kind === "entries" && engagement.verdict.kind === "refuse";
      latest.current.scope?.setOver({ key, refused });
      if (engagement.kind === "entries") showDragHint(key, engagement.verdict, event);
      if (refused) {
        event.dataTransfer.dropEffect = "none";
        return;
      }
      // Only an accepted drop cancels the default; a refused one keeps the no-drop cursor.
      event.preventDefault();
      event.dataTransfer.dropEffect = engagement.kind === "files" ? "copy" : "move";
    },
    [key],
  );

  const dropProps = useMemo<DropProps>(
    () => ({
      onDragEnter(event) {
        const engagement = engage(event);
        if (!engagement) return;
        latest.current.scope?.count(key, 1);
        light(event, engagement);
        const refused = engagement.kind === "entries" && engagement.verdict.kind === "refuse";
        if (!refused && !spring.current && latest.current.onSpring)
          spring.current = setTimeout(() => latest.current.onSpring?.(), SPRING_MS);
      },
      onDragOver(event) {
        const engagement = engage(event);
        // A drag that began inside this target never fires `dragenter` here.
        if (engagement) light(event, engagement);
      },
      onDragLeave(event) {
        if (!engage(event)) return;
        stopSpring();
        if (latest.current.scope?.count(key, -1) === 0) clearDragHint(key);
      },
      onDrop(event) {
        const engagement = engage(event);
        stopSpring();
        latest.current.scope?.count(key, "reset");
        clearDragHint(key);
        if (!engagement) return;
        if (engagement.kind === "entries" && engagement.verdict.kind === "refuse") return;
        event.preventDefault();
        event.stopPropagation();
        const { scope: currentScope, target: current } = latest.current;
        if (engagement.kind === "files")
          currentScope?.routes.files?.drop(current, captureDrop(event.dataTransfer));
        else currentScope?.routes.entries?.drop(current);
      },
    }),
    [engage, light, key, stopSpring],
  );

  if (!scope) return { dropProps: NO_PROPS, dropState: "idle" };
  const lit = scope.over?.key === key;
  return {
    dropProps,
    dropState: !lit ? "idle" : scope.over?.refused ? "refused" : "over",
  };
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
