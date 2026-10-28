/**
 * Activity toast registry: the keyed store behind the app-wide `ToastRegion`.
 *
 * Any owner (an import, an export) registers a toast under its own key and
 * supplies its own content; the registry knows nothing about what the toast is
 * for. The registry holds order (oldest first, an update keeps its place),
 * which cards the writer collapsed (for the life of the tab), and which toasts
 * the region actually has on screen in a visible tab. Owners read that last
 * fact with `useToastVisible` to time things like a clean "Done" closing itself.
 *
 * One registry per authenticated tree (`ToastRegistryProvider`); tests build
 * their own with `createToastRegistry`. The provider also holds the desktop
 * region's layout: the host element project notices portal into
 * (`useToastRegionLayout`), so they stack in the same corner as the toasts, and
 * the elements the region rises above rather than covers (`useToastClearance`).
 */
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

export type ActivityToastSpec = {
  /** The toast's name: its one line when collapsed, and the bar's accessible name. */
  title: string;
  /** A fact line under the title. */
  detail?: ReactNode;
  /** 0 to 100, or "indeterminate". Omit when nothing is running. */
  progress?: number | "indeterminate";
  /** Buttons for the actions row. */
  actions?: ReactNode;
  /** Extra body between the bar and the actions (for example a list of problems). */
  children?: ReactNode;
  /** Close control. Omit it and the card has none (a decision the writer must make). */
  onClose?: () => void;
};

export type ActivityToast = ActivityToastSpec & { key: string };

type Snapshot = {
  /** Oldest first. The region shows the tail. */
  toasts: readonly ActivityToast[];
  collapsed: ReadonlySet<string>;
  /** Toasts on screen right now in a visible tab. */
  visible: ReadonlySet<string>;
  /** Increments when an owner asks for a toast to be brought forward. */
  revealRequest: number;
};

export type ToastRegistry = ReturnType<typeof createToastRegistry>;

export function createToastRegistry() {
  let snapshot: Snapshot = {
    toasts: [],
    collapsed: new Set(),
    visible: new Set(),
    revealRequest: 0,
  };
  const listeners = new Set<() => void>();
  const commit = (next: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,

    /** Registers the toast, or replaces its content in place. */
    show(key: string, spec: ActivityToastSpec) {
      const at = snapshot.toasts.findIndex((toast) => toast.key === key);
      const toast = { ...spec, key };
      commit({
        toasts:
          at < 0
            ? [...snapshot.toasts, toast]
            : snapshot.toasts.map((existing, i) => (i === at ? toast : existing)),
      });
    },
    /** Merges into a registered toast; does nothing when it is gone. */
    update(key: string, patch: Partial<ActivityToastSpec>) {
      if (!snapshot.toasts.some((toast) => toast.key === key)) return;
      commit({
        toasts: snapshot.toasts.map((toast) =>
          toast.key === key ? { ...toast, ...patch } : toast,
        ),
      });
    },
    remove(key: string) {
      if (!snapshot.toasts.some((toast) => toast.key === key)) return;
      const collapsed = new Set(snapshot.collapsed);
      collapsed.delete(key);
      commit({ toasts: snapshot.toasts.filter((toast) => toast.key !== key), collapsed });
    },
    /** Brings the toast forward: newest slot, expanded; the phone opens its sheet. */
    reveal(key: string) {
      const toast = snapshot.toasts.find((candidate) => candidate.key === key);
      if (!toast) return;
      const collapsed = new Set(snapshot.collapsed);
      collapsed.delete(key);
      commit({
        toasts: [...snapshot.toasts.filter((candidate) => candidate !== toast), toast],
        collapsed,
        revealRequest: snapshot.revealRequest + 1,
      });
    },

    setCollapsed(key: string, collapsed: boolean) {
      if (snapshot.collapsed.has(key) === collapsed) return;
      const next = new Set(snapshot.collapsed);
      if (collapsed) next.add(key);
      else next.delete(key);
      commit({ collapsed: next });
    },
    /** The region reports what it has on screen. Not for owners. */
    reportVisible(keys: ReadonlySet<string>) {
      const same =
        keys.size === snapshot.visible.size && [...keys].every((key) => snapshot.visible.has(key));
      if (!same) commit({ visible: keys });
    },
  };
}

const ToastRegistryContext = createContext<ToastRegistry | null>(null);

type RegionLayout = {
  host: HTMLElement | null;
  setHost: (host: HTMLElement | null) => void;
  clearances: ReadonlySet<HTMLElement>;
  clear: (element: HTMLElement) => () => void;
};
const RegionLayoutContext = createContext<RegionLayout | null>(null);

export function ToastRegistryProvider({
  registry,
  children,
}: {
  /** Tests pass their own; the app lets the provider own one for its lifetime. */
  registry?: ToastRegistry;
  children: ReactNode;
}) {
  const [owned] = useState(createToastRegistry);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [clearances, setClearances] = useState<ReadonlySet<HTMLElement>>(() => new Set());
  const clear = useCallback((element: HTMLElement) => {
    setClearances((current) => new Set(current).add(element));
    return () =>
      setClearances((current) => {
        const next = new Set(current);
        next.delete(element);
        return next;
      });
  }, []);
  const layout = useMemo(() => ({ host, setHost, clearances, clear }), [host, clearances, clear]);
  return (
    <ToastRegistryContext.Provider value={registry ?? owned}>
      <RegionLayoutContext.Provider value={layout}>{children}</RegionLayoutContext.Provider>
    </ToastRegistryContext.Provider>
  );
}

/** The desktop region's layout: where notices portal in (null until it mounts) and what it rises above. */
export function useToastRegionLayout(): RegionLayout {
  const layout = useContext(RegionLayoutContext);
  if (!layout) throw new Error("useToastRegionLayout needs a ToastRegistryProvider above it.");
  return layout;
}

/**
 * Keeps the desktop region from covering the element (the pinned chat composer):
 * while it is mounted, the region rises above it whenever they would overlap.
 */
export function useToastClearance(ref: RefObject<HTMLElement | null>): void {
  const { clear } = useToastRegionLayout();
  useEffect(() => {
    const element = ref.current;
    return element ? clear(element) : undefined;
  }, [clear, ref]);
}

/** The registry for imperative owners: `show`, `update`, `remove`, `reveal`. */
export function useToastRegistry(): ToastRegistry {
  const registry = useContext(ToastRegistryContext);
  if (!registry) throw new Error("useToastRegistry needs a ToastRegistryProvider above it.");
  return registry;
}

export function useToastSnapshot(): Snapshot {
  const registry = useToastRegistry();
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}

/**
 * Keeps a toast registered while the calling component renders `spec`, and
 * removes it when `spec` is null or the component unmounts. A change of `key`
 * removes the old toast.
 */
export function useActivityToast(key: string, spec: ActivityToastSpec | null): void {
  const registry = useToastRegistry();
  useEffect(() => {
    if (spec) registry.show(key, spec);
    else registry.remove(key);
  }, [registry, key, spec]);
  useEffect(() => () => registry.remove(key), [registry, key]);
}

/**
 * True while the region has this toast on screen (expanded or collapsed, not
 * folded into "+N more" or "N in progress") and the browser tab is visible.
 * An owner starts its "seen for 6 seconds" timer on true and cancels it on false.
 */
export function useToastVisible(key: string): boolean {
  const registry = useToastRegistry();
  // A boolean snapshot: the owner re-renders only when its own toast flips, so
  // an owner that also registers the toast on every render cannot loop.
  return useSyncExternalStore(
    registry.subscribe,
    () => registry.getSnapshot().visible.has(key),
    () => false,
  );
}

/** Layout reserves space for the phone bar without subscribing to progress ticks. */
export function useHasActivityToast(): boolean {
  const registry = useToastRegistry();
  return useSyncExternalStore(
    registry.subscribe,
    () => registry.getSnapshot().toasts.length > 0,
    () => false,
  );
}
