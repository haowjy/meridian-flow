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
import type { SelectableEntry } from "./entry";

export type EntrySelection = {
  /** Rows drag on the desktop shell only; the phone has no drag (owner, 2026-10-11). */
  draggable: boolean;
  /** Shown as selected: part of an explicit selection. The open row has its own highlight. */
  isSelected(key: string): boolean;
  /** True when the click was a selection gesture and must not open the row. */
  click(entry: SelectableEntry, event: MouseEvent | KeyboardEvent): boolean;
  /** What a drag of this row carries, in screen order; a row outside the selection goes alone. */
  dragged(entry: SelectableEntry): SelectableEntry[];
  /** Selects exactly these keys (after a move), even one; none returns to the open row. */
  replace(keys: readonly string[]): void;
  clear(): void;
  /** Rows announce themselves while mounted; the open row says so. */
  register(entry: SelectableEntry, active: boolean): () => void;
  root: RefObject<HTMLDivElement | null>;
};

const KEY_ATTRIBUTE = "data-entry-key";

/** One list's selection; the list component owns it and hands it to its rows and drop route. */
export function useEntrySelection(): EntrySelection {
  // null: no explicit selection, so the selection is the open row.
  const [explicit, setExplicit] = useState<ReadonlySet<string> | null>(null);
  const anchor = useRef<string | null>(null);
  const registry = useRef(new Map<string, { entry: SelectableEntry; active: boolean }>());
  const root = useRef<HTMLDivElement>(null);
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
        if (event.shiftKey && anchor.current) {
          const order = screenOrder();
          const from = order.indexOf(anchor.current);
          const to = order.indexOf(entry.key);
          if (from >= 0 && to >= 0) {
            const [start, end] = from < to ? [from, to] : [to, from];
            setExplicit(new Set(order.slice(start, end + 1)));
            return true;
          }
        }
        if (event.metaKey || event.ctrlKey) {
          anchor.current = entry.key;
          setExplicit((previous) => {
            const open = openKey();
            const next = new Set(previous ?? (open ? [open] : []));
            if (next.has(entry.key)) next.delete(entry.key);
            else next.add(entry.key);
            return next;
          });
          return true;
        }
        anchor.current = entry.key;
        setExplicit(null);
        return false;
      },
      dragged(entry) {
        const selected = current();
        if (!selected.has(entry.key)) return [entry];
        const rows = screenOrder()
          .filter((key) => selected.has(key))
          .map((key) => registry.current.get(key)?.entry)
          .filter((row): row is SelectableEntry => row !== undefined);
        return withoutNested(rows);
      },
      replace(keys) {
        setExplicit(keys.length > 0 ? new Set(keys) : null);
      },
      clear() {
        setExplicit(null);
      },
      register(entry, active) {
        registry.current.set(entry.key, { entry, active });
        return () => {
          if (registry.current.get(entry.key)?.entry === entry) registry.current.delete(entry.key);
        };
      },
    };
  }, [explicit, draggable, screenOrder, openKey]);
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

/** A folder carries its contents, so a selected row inside a selected folder is dropped. */
function withoutNested(entries: SelectableEntry[]): SelectableEntry[] {
  const folders = entries.filter((entry) => entry.kind === "folder");
  return entries.filter(
    (entry) =>
      !folders.some(
        (folder) =>
          folder !== entry &&
          folder.catalogRootId === entry.catalogRootId &&
          entry.path.startsWith(`${folder.path}/`),
      ),
  );
}

/** A row's place in its list's selection; inert outside one (phone browsing). */
export function useEntrySelectionRow(entry: SelectableEntry, active: boolean) {
  const selection = useContext(SelectionContext);
  useLayoutEffect(() => selection?.register(entry, active), [selection, entry, active]);
  return {
    selection,
    selected: selection?.isSelected(entry.key) ?? false,
    /** Spread on the row so range selection can read screen order. */
    rowProps: { [KEY_ATTRIBUTE]: entry.key },
  };
}
