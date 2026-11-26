import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { type DragEntry, type EntryRef, entryKey } from "./entry";

export type SelectionGrant = "move" | "delete" | "restore";

export type EntryList = "project" | "account";

export type SelectionGroup = {
  entries: DragEntry[];
  grants: SelectionGrant[];
  crossesLists: boolean;
};

export type EntrySelection = {
  draggable: boolean;
  isSelected(key: string): boolean;
  click(entry: DragEntry, event: MouseEvent | KeyboardEvent): boolean;
  dragged(entry: DragEntry): DragEntry[];
  group(entry: DragEntry): SelectionGroup | null;
  pick(entry: DragEntry): void;
  replace(keys: readonly string[]): void;
  clear(): void;
  focus(): void;
  settleFocus(): void;
  register(entry: DragEntry, active: boolean): () => void;
  grant(entry: DragEntry, grants: readonly SelectionGrant[], list: EntryList): () => void;
  root: RefObject<HTMLDivElement | null>;
};

const KEY_ATTRIBUTE = "data-entry-key";
const RUN_ATTRIBUTE = "data-selection-run";
const FOCUS_RECLAIM_MS = 2000;

const departures = new Set<(keys: ReadonlySet<string>) => void>();

/**
 * Rows a delete or restore takes out of their list leave every list's selection, so a row that
 * comes back (restored, or deleted into Trash) never arrives selected.
 */
export function leaveSelections(refs: readonly EntryRef[]) {
  const keys = new Set(refs.map(entryKey));
  for (const leave of departures) leave(keys);
}

export function useEntrySelection(): EntrySelection {
  const [explicit, setExplicit] = useState<ReadonlySet<string> | null>(null);
  const anchor = useRef<string | null>(null);
  const registry = useRef(new Map<string, { entry: DragEntry; active: boolean }>());
  const granted = useRef(
    new Map<string, { entry: DragEntry; grants: readonly SelectionGrant[]; list: EntryList }>(),
  );
  const root = useRef<HTMLDivElement>(null);
  const focusUntil = useRef(0);
  const parked = useRef<HTMLElement | null>(null);
  const shown = useRef<ReadonlySet<string> | null>(null);
  shown.current = explicit;
  const painting = useRef(false);
  const settling = useRef(false);

  const paintRuns = useCallback(() => {
    if (painting.current) return;
    painting.current = true;
    queueMicrotask(() => {
      painting.current = false;
      const rows = Array.from(
        root.current?.querySelectorAll<HTMLElement>(`[${KEY_ATTRIBUTE}]`) ?? [],
      );
      const on = rows.map((row) => shown.current?.has(row.getAttribute(KEY_ATTRIBUTE) ?? ""));
      const boxes = rows.map((row, index) => (on[index] ? row.getBoundingClientRect() : null));
      const touches = (a: number, b: number) => {
        const upper = boxes[a];
        const lower = boxes[b];
        return Boolean(upper && lower && Math.abs(lower.top - upper.bottom) < 1);
      };
      rows.forEach((row, index) => {
        if (!on[index]) {
          row.removeAttribute(RUN_ATTRIBUTE);
          return;
        }
        const above = touches(index - 1, index);
        const below = touches(index, index + 1);
        row.setAttribute(
          RUN_ATTRIBUTE,
          above && below ? "middle" : above ? "end" : below ? "start" : "single",
        );
      });
    });
  }, []);
  const draggable = usePhoneShell() !== true;

  const settleFocus = useCallback(() => {
    if (settling.current || Date.now() >= focusUntil.current) return;
    settling.current = true;
    requestAnimationFrame(() => {
      settling.current = false;
      const selected = shown.current;
      const rows = Array.from(
        root.current?.querySelectorAll<HTMLElement>(`[${KEY_ATTRIBUTE}]`) ?? [],
      ).filter((row) => selected?.has(row.getAttribute(KEY_ATTRIBUTE) ?? ""));
      const [first] = rows;
      const active = document.activeElement;
      const lost = active === null || active === document.body || active === parked.current;
      if (first && first !== active && (lost || rows.some((row) => row === active))) first.focus();
    });
  }, []);

  useEffect(() => {
    const leave = (keys: ReadonlySet<string>) => {
      if (anchor.current && keys.has(anchor.current)) anchor.current = null;
      setExplicit((previous) => {
        if (!previous) return previous;
        const next = new Set([...previous].filter((key) => !keys.has(key)));
        if (next.size === previous.size) return previous;
        return next.size > 0 ? next : null;
      });
    };
    departures.add(leave);
    return () => {
      departures.delete(leave);
    };
  }, []);

  const screenOrder = useCallback((): string[] => {
    const nodes = root.current?.querySelectorAll<HTMLElement>(`[${KEY_ATTRIBUTE}]`) ?? [];
    return Array.from(nodes, (node) => node.getAttribute(KEY_ATTRIBUTE) ?? "");
  }, []);

  const openKey = useCallback(() => {
    for (const [key, row] of registry.current) if (row.active) return key;
    return null;
  }, []);

  return useMemo<EntrySelection>(() => {
    const current = (): ReadonlySet<string> => {
      if (explicit) return explicit;
      const open = openKey();
      return new Set(open ? [open] : []);
    };
    const selectedRows = (entry: DragEntry) => {
      const selected = current();
      if (!selected.has(entryKey(entry.ref))) return null;
      return screenOrder().flatMap((key) => {
        const row = selected.has(key) ? registry.current.get(key) : undefined;
        return row ? [row] : [];
      });
    };
    return {
      draggable,
      root,
      isSelected: (key) => explicit?.has(key) ?? false,
      click(entry, event) {
        const key = entryKey(entry.ref);
        if (event.shiftKey) {
          const order = screenOrder();
          const to = order.indexOf(key);
          let from = anchor.current ? order.indexOf(anchor.current) : -1;
          if (from < 0) {
            const open = openKey();
            from = open ? order.indexOf(open) : -1;
            if (from < 0) from = to;
            anchor.current = order[from] ?? key;
          }
          if (to >= 0) {
            const [start, end] = from < to ? [from, to] : [to, from];
            setExplicit(new Set(order.slice(start, end + 1)));
            return true;
          }
        }
        if (event.metaKey || event.ctrlKey) {
          anchor.current = key;
          setExplicit((previous) => {
            const open = openKey();
            const next = new Set(previous ?? (open ? [open] : []));
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          });
          return true;
        }
        anchor.current = key;
        setExplicit(null);
        return false;
      },
      dragged(entry) {
        return selectedRows(entry)?.map((row) => row.entry) ?? [entry];
      },
      group(entry) {
        const rows = selectedRows(entry);
        if (!rows || rows.length < 2) return null;
        const grantsOf = rows.map((row) => granted.current.get(entryKey(row.entry.ref)));
        return {
          entries: rows.map((row) => row.entry),
          grants: (["move", "delete", "restore"] as const).filter((grant) =>
            grantsOf.every((each) => each?.grants.includes(grant)),
          ),
          crossesLists: new Set(grantsOf.map((each) => each?.list)).size > 1,
        };
      },
      pick(entry) {
        const key = entryKey(entry.ref);
        if (current().has(key)) return;
        anchor.current = key;
        setExplicit(openKey() === key ? null : new Set([key]));
      },
      replace(keys) {
        setExplicit(keys.length > 0 ? new Set(keys) : null);
      },
      clear() {
        setExplicit(null);
      },
      focus() {
        const list = root.current;
        const rows = list?.querySelectorAll<HTMLElement>(`[${KEY_ATTRIBUTE}]`) ?? [];
        const first = Array.from(rows).find((row) =>
          current().has(row.getAttribute(KEY_ATTRIBUTE) ?? ""),
        );
        const target = first ?? rows[0];
        target?.focus();
        parked.current = first ? null : (target ?? null);
        focusUntil.current = Date.now() + FOCUS_RECLAIM_MS;
      },
      settleFocus,
      register(entry, active) {
        const key = entryKey(entry.ref);
        registry.current.set(key, { entry, active });
        paintRuns();
        settleFocus();
        return () => {
          if (registry.current.get(key)?.entry === entry) registry.current.delete(key);
          paintRuns();
        };
      },
      grant(entry, grants, list) {
        const key = entryKey(entry.ref);
        granted.current.set(key, { entry, grants, list });
        return () => {
          if (granted.current.get(key)?.entry === entry) granted.current.delete(key);
        };
      },
    };
  }, [explicit, draggable, screenOrder, openKey, paintRuns, settleFocus]);
}

const SelectionContext = createContext<EntrySelection | null>(null);

export function selectRows(selection: EntrySelection | null, rows: readonly EntryRef[]) {
  if (rows.length > 0) selection?.replace(rows.map(entryKey));
}

export function useOptionalEntrySelection(): EntrySelection | null {
  return useContext(SelectionContext);
}

export function EntrySelectionProvider({
  selection,
  children,
}: {
  selection: EntrySelection;
  children: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent) => {
    // A row's menu is portaled but still bubbles here; its Escape closes the menu, not the selection.
    if (event.key === "Escape" && selection.root.current?.contains(event.target as Node))
      selection.clear();
  };
  return (
    <SelectionContext.Provider value={selection}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape clears the selection made by the rows inside. slop-lint: allow suppression the reason is stated in this comment */}
      <div
        ref={selection.root}
        className="contents"
        onKeyDown={onKeyDown}
        onBlur={selection.settleFocus}
      >
        {children}
      </div>
    </SelectionContext.Provider>
  );
}

export function useEntrySelectionRow(entry: DragEntry, active: boolean) {
  const selection = useContext(SelectionContext);
  const key = entryKey(entry.ref);
  useLayoutEffect(() => selection?.register(entry, active), [selection, entry, active]);
  const selected = selection?.isSelected(key) ?? false;
  return {
    selection,
    selected,
    rowProps: { [KEY_ATTRIBUTE]: key, "aria-pressed": selected || undefined },
  };
}
