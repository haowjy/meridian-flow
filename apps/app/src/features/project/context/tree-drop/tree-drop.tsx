/**
 * The one drop dispatcher on the project tree. Payloads from the desktop
 * (`Files`) go to import; internal payloads (`entries`) belong to drag-anywhere,
 * which plugs its route into the same seam. Nothing here moves or copies rows.
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
import { dragPayloadKind } from "./drag-payload";

export type TreeDropTarget = {
  scheme: ProjectContextTreeScheme;
  /** The folder row, or null for the area root (the header). */
  folder: { entryId: string; path: string; uri: string; name: string } | null;
};

export type TreeDropRoutes = {
  files?: {
    accepts(target: TreeDropTarget): boolean;
    drop(target: TreeDropTarget, items: DroppedItems): void;
  };
  /** Drag-anywhere's route. Not built here. */
  entries?: {
    accepts(target: TreeDropTarget, dataTransfer: DataTransfer): boolean;
    drop(target: TreeDropTarget, dataTransfer: DataTransfer): void;
  };
};

const SPRING_MS = 600;

type ScopeValue = {
  routes: TreeDropRoutes;
  over: string | null;
  setOver(key: string | null, ownerOnly?: string): void;
};

const ScopeContext = createContext<ScopeValue | null>(null);

export function targetKey(target: TreeDropTarget): string {
  return `${target.scheme}:${target.folder?.entryId ?? "root"}`;
}

/** Holds the routes and the one highlighted target for an area's header and rows. */
export function TreeDropScope({
  routes,
  children,
}: {
  routes: TreeDropRoutes;
  children: ReactNode;
}) {
  const [over, setOverState] = useState<string | null>(null);
  const setOver = useCallback((key: string | null, ownerOnly?: string) => {
    setOverState((current) => (ownerOnly !== undefined && current !== ownerOnly ? current : key));
  }, []);
  const value = useMemo(() => ({ routes, over, setOver }), [routes, over, setOver]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

type DropProps = Pick<
  HTMLAttributes<HTMLElement>,
  "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop"
>;

const NO_PROPS: DropProps = {};

/**
 * Drop handlers for one target. `dragenter` and `dragleave` are counted so
 * moving over a child does not flicker the highlight. Hovering an accepted
 * target for 600 ms calls `onSpring` (a collapsed folder opens).
 */
export function useTreeDropTarget(
  target: TreeDropTarget,
  options: { onSpring?: () => void } = {},
): { dropProps: DropProps; dropState: "idle" | "over" } {
  const scope = useContext(ScopeContext);
  const key = targetKey(target);
  const depth = useRef(0);
  const spring = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ target, scope, onSpring: options.onSpring });
  latest.current = { target, scope, onSpring: options.onSpring };

  const stopSpring = useCallback(() => {
    if (spring.current) clearTimeout(spring.current);
    spring.current = undefined;
  }, []);
  useEffect(() => stopSpring, [stopSpring]);

  const accepted = useCallback((event: DragEvent): "files" | "entries" | null => {
    const { target: current, scope: currentScope } = latest.current;
    if (!currentScope) return null;
    const kind = dragPayloadKind(Array.from(event.dataTransfer?.types ?? []));
    if (kind === "files" && currentScope.routes.files?.accepts(current)) return "files";
    if (kind === "entries" && currentScope.routes.entries?.accepts(current, event.dataTransfer))
      return "entries";
    return null;
  }, []);

  const dropProps = useMemo<DropProps>(
    () => ({
      onDragEnter(event) {
        if (!accepted(event)) return;
        event.preventDefault();
        depth.current += 1;
        latest.current.scope?.setOver(key);
        if (!spring.current && latest.current.onSpring)
          spring.current = setTimeout(() => latest.current.onSpring?.(), SPRING_MS);
      },
      onDragOver(event) {
        if (!accepted(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        // A drag that began inside this target never fires `dragenter` here.
        latest.current.scope?.setOver(key);
      },
      onDragLeave(event) {
        if (!accepted(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) {
          stopSpring();
          latest.current.scope?.setOver(null, key);
        }
      },
      onDrop(event) {
        const kind = accepted(event);
        depth.current = 0;
        stopSpring();
        latest.current.scope?.setOver(null);
        if (!kind) return;
        event.preventDefault();
        event.stopPropagation();
        const { scope: currentScope, target: current } = latest.current;
        if (kind === "files")
          currentScope?.routes.files?.drop(current, captureDrop(event.dataTransfer));
        else currentScope?.routes.entries?.drop(current, event.dataTransfer);
      },
    }),
    [accepted, key, stopSpring],
  );

  if (!scope) return { dropProps: NO_PROPS, dropState: "idle" };
  return { dropProps, dropState: scope.over === key ? "over" : "idle" };
}

/**
 * Keeps a stray file drop from replacing the app with the file. Acts only when
 * nothing earlier claimed the event, so the editor's picture drops are untouched.
 */
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
