/**
 * Row selection for one list, on VS Code's model. A plain click opens or
 * toggles the row and leaves no selection of its own: until the writer
 * Ctrl/Cmd- or Shift-clicks, the selection is just the open row. Ctrl/Cmd-click
 * starts an explicit selection from the open row and adds or removes rows;
 * Shift-click selects the on-screen range from the last clicked row; Escape
 * returns to the open row. Dragging a selected row carries the whole selection.
 * Range order is the order rows appear on screen, read from the DOM, so it
 * always matches what the writer sees.
 *
 * The list that renders the rows owns the selection (`useEntrySelection`), so
 * its drop route can reselect what it moved; rows read it through the provider.
 */
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { type DragEntry, entryKey } from "./entry";

export type EntrySelection = {
  /** Rows drag on the desktop shell only; the phone has no drag (owner, 2026-10-11). */
  draggable: boolean;
  /** Shown as selected: part of an explicit selection. The open row has its own highlight. */
  isSelected(key: string): boolean;
  /** True when the click was a selection gesture and must not open the row. */
  click(entry: DragEntry, event: MouseEvent | KeyboardEvent): boolean;
  /** What a drag of this row carries, in screen order; a row outside the selection goes alone. */
  dragged(entry: DragEntry): DragEntry[];
  /** Selects exactly these keys (after a move), even one; none returns to the open row. */
  replace(keys: readonly string[]): void;
  clear(): void;
  /**
   * Focuses the list's first selected row, or its first row. A selected row that
   * remounts soon after (a moved row arriving in its folder) takes focus back
   * while nothing else holds it.
   */
  focus(): void;
  /** Whether a row mounting now should take focus (see `focus`). */
  reclaimsFocus(key: string): boolean;
  /** Rows announce themselves while mounted; the open row says so. */
  register(entry: DragEntry, active: boolean): () => void;
  root: RefObject<HTMLDivElement | null>;
};

const KEY_ATTRIBUTE = "data-entry-key";
/** Set on a selected row: `start`, `middle`, `end` or `single` within its run. */
const RUN_ATTRIBUTE = "data-selection-run";
// Long enough for the catalogs to catch up with a move and remount its rows.
const FOCUS_RECLAIM_MS = 2000;

/**
 * One list's selection; the list component owns it and hands it to its rows and
 * drop route. `prune` drops from a drag the rows a carried folder already
 * carries; the list knows the current ancestry, the selection does not.
 */
export function useEntrySelection(
  prune: (entries: DragEntry[]) => DragEntry[] = (entries) => entries,
): EntrySelection {
  // null: no explicit selection, so the selection is the open row.
  const [explicit, setExplicit] = useState<ReadonlySet<string> | null>(null);
  const anchor = useRef<string | null>(null);
  const registry = useRef(new Map<string, { entry: DragEntry; active: boolean }>());
  const root = useRef<HTMLDivElement>(null);
  const focusUntil = useRef(0);
  const shown = useRef<ReadonlySet<string> | null>(null);
  shown.current = explicit;
  const painting = useRef(false);

  /**
   * Marks where each run of selected rows that touch on screen starts and ends,
   * so a run draws as one block. Rows sit at different depths under separate
   * wrappers, and a section header can sit between two rows, so touching is
   * read from geometry, once per commit, not per row.
   */
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
    return {
      draggable,
      root,
      isSelected: (key) => explicit?.has(key) ?? false,
      click(entry, event) {
        const key = entryKey(entry.ref);
        if (event.shiftKey && anchor.current) {
          const order = screenOrder();
          const from = order.indexOf(anchor.current);
          const to = order.indexOf(key);
          if (from >= 0 && to >= 0) {
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
        const selected = current();
        if (!selected.has(entryKey(entry.ref))) return [entry];
        const rows = screenOrder()
          .filter((key) => selected.has(key))
          .map((key) => registry.current.get(key)?.entry)
          .filter((row): row is DragEntry => row !== undefined);
        return prune(rows);
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
        (first ?? rows[0])?.focus();
        focusUntil.current = Date.now() + FOCUS_RECLAIM_MS;
      },
      reclaimsFocus(key) {
        const lost = document.activeElement === null || document.activeElement === document.body;
        return lost && Date.now() < focusUntil.current && current().has(key);
      },
      register(entry, active) {
        const key = entryKey(entry.ref);
        registry.current.set(key, { entry, active });
        paintRuns();
        return () => {
          if (registry.current.get(key)?.entry === entry) registry.current.delete(key);
          paintRuns();
        };
      },
    };
  }, [explicit, draggable, screenOrder, openKey, prune, paintRuns]);
}

const SelectionContext = createContext<EntrySelection | null>(null);

/** Gives the list's rows its selection; Escape inside returns to the open row. */
export function EntrySelectionProvider({
  selection,
  children,
}: {
  selection: EntrySelection;
  children: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") selection.clear();
  };
  return (
    <SelectionContext.Provider value={selection}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape clears the selection made by the rows inside. */}
      <div ref={selection.root} className="contents" onKeyDown={onKeyDown}>
        {children}
      </div>
    </SelectionContext.Provider>
  );
}

/** A row's place in its list's selection; inert outside one (phone browsing). */
export function useEntrySelectionRow(entry: DragEntry, active: boolean) {
  const selection = useContext(SelectionContext);
  const key = entryKey(entry.ref);
  useLayoutEffect(() => selection?.register(entry, active), [selection, entry, active]);
  const selected = selection?.isSelected(key) ?? false;
  const reclaim = useCallback(
    (row: HTMLElement | null) => {
      if (row && selection?.reclaimsFocus(key)) row.focus();
    },
    [selection, key],
  );
  return {
    selection,
    selected,
    /**
     * Spread on the row so range selection can read screen order. Rows are buttons, so
     * the selection is their pressed state; outside an explicit selection they aren't toggles.
     */
    rowProps: { [KEY_ATTRIBUTE]: key, "aria-pressed": selected || undefined, ref: reclaim },
  };
}
