/**
 * Row selection for one list, on VS Code's model: a click selects the row (and
 * the row opens as before), Ctrl/Cmd-click adds or removes a row starting from
 * the open document, Shift-click selects the visible range from the last
 * clicked row, Escape clears. A selection of one row is just the open
 * document's highlight; the fill appears on a row only once two are selected. Dragging
 * a selected row carries the whole selection. Range order is the order rows
 * appear on screen, read from the DOM, so it always matches what the writer sees.
 */
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import type { SelectableEntry } from "./entry";

type SelectionValue = {
  /** Rows drag on the desktop shell only; the phone has no drag (owner, 2026-10-11). */
  draggable: boolean;
  /** Selected and shown as selected: one of two or more, or the open row itself. */
  isSelected(key: string, active: boolean): boolean;
  /** True when the click was a selection gesture and must not open the row. */
  click(entry: SelectableEntry, event: MouseEvent | KeyboardEvent): boolean;
  /** The entries a drag of this row carries, in screen order; selects the row if it was not. */
  dragged(entry: SelectableEntry): SelectableEntry[];
  /** Selects exactly these keys (after a move). */
  replace(keys: readonly string[]): void;
  register(entry: SelectableEntry, active: boolean): void;
};

const SelectionContext = createContext<SelectionValue | null>(null);

const KEY_ATTRIBUTE = "data-entry-key";

/** One list's selection; every selectable row inside reads it. */
export function EntrySelectionScope({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const registry = useRef(new Map<string, SelectableEntry>());
  const activeKey = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const draggable = usePhoneShell() !== true;

  const screenOrder = useCallback((): string[] => {
    const nodes = root.current?.querySelectorAll<HTMLElement>(`[${KEY_ATTRIBUTE}]`) ?? [];
    return Array.from(nodes, (node) => node.getAttribute(KEY_ATTRIBUTE) ?? "");
  }, []);

  const value = useMemo<SelectionValue>(() => {
    const entriesInOrder = (keys: ReadonlySet<string>) =>
      screenOrder()
        .filter((key) => keys.has(key))
        .map((key) => registry.current.get(key))
        .filter((entry): entry is SelectableEntry => entry !== undefined);
    return {
      draggable,
      isSelected: (key, active) => selected.has(key) && (selected.size > 1 || active),
      click(entry, event) {
        const toggle = event.metaKey || event.ctrlKey;
        if (event.shiftKey && anchor.current) {
          const order = screenOrder();
          const from = order.indexOf(anchor.current);
          const to = order.indexOf(entry.key);
          if (from >= 0 && to >= 0) {
            const [start, end] = from < to ? [from, to] : [to, from];
            setSelected(new Set(order.slice(start, end + 1)));
            return true;
          }
        }
        anchor.current = entry.key;
        if (toggle) {
          setSelected((current) => {
            // A lone selection may be stale (the open document changed elsewhere); start from what is open.
            const next = new Set(
              current.size > 1 ? current : activeKey.current ? [activeKey.current] : [],
            );
            if (next.has(entry.key)) next.delete(entry.key);
            else next.add(entry.key);
            return next;
          });
          return true;
        }
        setSelected(new Set([entry.key]));
        return false;
      },
      dragged(entry) {
        if (!selected.has(entry.key)) {
          anchor.current = entry.key;
          setSelected(new Set([entry.key]));
          return [entry];
        }
        return withoutNested(entriesInOrder(selected));
      },
      replace(keys) {
        setSelected(new Set(keys));
      },
      register(entry, active) {
        registry.current.set(entry.key, entry);
        if (active) activeKey.current = entry.key;
        else if (activeKey.current === entry.key) activeKey.current = null;
      },
    };
  }, [selected, screenOrder, draggable]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && selected.size > 0) setSelected(new Set());
  };

  return (
    <SelectionContext.Provider value={value}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape clears the selection made by the rows inside. */}
      <div ref={root} className="contents" onKeyDown={onKeyDown}>
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
          folder.catalog === entry.catalog &&
          entry.path.startsWith(`${folder.path}/`),
      ),
  );
}

/** The list's selection, for a drop route that reselects what it moved. */
export function useOptionalEntrySelectionScope() {
  return useContext(SelectionContext);
}

/** A row's selection state and handlers; inert outside a selection scope (phone). */
export function useEntrySelection(entry: SelectableEntry | null, active = false) {
  const scope = useContext(SelectionContext);
  if (scope && entry) scope.register(entry, active);
  return {
    scope,
    selected: Boolean(scope && entry && scope.isSelected(entry.key, active)),
    /** Spread on the row so range selection can read screen order. */
    rowProps: entry ? { [KEY_ATTRIBUTE]: entry.key } : {},
  };
}
