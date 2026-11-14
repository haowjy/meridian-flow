/** What a context entry's row menu offers (its right-click and ⋯ alike), one row or a selection. */
import { plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  ArchiveRestore,
  Copy,
  FilePlus,
  Files,
  Folder,
  FolderInput,
  FolderPlus,
  ImportIcon,
  type LucideIcon,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useLayoutEffect, useState } from "react";
import type { RowMenu, RowMenuEntry, RowMenuItem } from "@/components/ui/row-menu";
import type { DragEntry } from "./entry-drag/entry";
import {
  type SelectionGrant,
  type SelectionGroup,
  useOptionalEntrySelection,
} from "./entry-drag/selection";

// ─── Action types ────────────────────────────────────────────────────────────

export type EntryAction =
  | "new-file"
  | "new-folder"
  | "import-folder"
  | "import-files"
  | "rename"
  | "move"
  | "copy"
  | "delete"
  | "restore"
  | "dismiss";

type EntryActionSpec = {
  action: EntryAction;
  label: ReactNode;
  icon: LucideIcon;
  group: "create" | "manage";
  destructive?: true;
  inImportMenu?: true;
};

const ENTRY_ACTIONS: readonly EntryActionSpec[] = [
  { action: "new-file", label: <Trans>New file</Trans>, icon: FilePlus, group: "create" },
  { action: "new-folder", label: <Trans>New folder</Trans>, icon: FolderPlus, group: "create" },
  {
    action: "import-folder",
    label: <Trans>Folder…</Trans>,
    icon: Folder,
    group: "create",
    inImportMenu: true,
  },
  {
    action: "import-files",
    label: <Trans>Files…</Trans>,
    icon: Files,
    group: "create",
    inImportMenu: true,
  },
  { action: "rename", label: <Trans>Rename</Trans>, icon: Pencil, group: "manage" },
  { action: "move", label: <Trans>Move…</Trans>, icon: FolderInput, group: "manage" },
  { action: "copy", label: <Trans>Copy to…</Trans>, icon: Copy, group: "manage" },
  {
    action: "delete",
    label: <Trans>Delete</Trans>,
    icon: Trash2,
    group: "manage",
    destructive: true,
  },
  { action: "restore", label: <Trans>Restore</Trans>, icon: ArchiveRestore, group: "manage" },
  { action: "dismiss", label: <Trans>Dismiss the error</Trans>, icon: X, group: "manage" },
];

/** What every row of a selection is: one kind names it, a mix is "items". */
function selectionNoun(entries: readonly DragEntry[]): "file" | "folder" | "item" {
  const [first] = entries;
  if (!first || entries.some((entry) => entry.ref.kind !== first.ref.kind)) return "item";
  return first.ref.kind === "folder" ? "folder" : "file";
}

/**
 * The menu of a selection of two or more rows: only what acts on all of them at once, so no
 * creation and no Rename. A second ordered specification through the same renderers.
 */
function selectionActions(group: SelectionGroup): EntryActionSpec[] {
  const n = group.entries.length;
  const noun = selectionNoun(group.entries);
  const specs: EntryActionSpec[] = [];
  if (group.grants.includes("move"))
    specs.push({
      action: "move",
      icon: FolderInput,
      group: "manage",
      label:
        noun === "file"
          ? plural(n, { one: "Move # file…", other: "Move # files…" })
          : noun === "folder"
            ? plural(n, { one: "Move # folder…", other: "Move # folders…" })
            : plural(n, { one: "Move # item…", other: "Move # items…" }),
    });
  if (group.grants.includes("delete"))
    specs.push({
      action: "delete",
      icon: Trash2,
      group: "manage",
      destructive: true,
      label:
        noun === "file"
          ? plural(n, { one: "Delete # file", other: "Delete # files" })
          : noun === "folder"
            ? plural(n, { one: "Delete # folder", other: "Delete # folders" })
            : plural(n, { one: "Delete # item", other: "Delete # items" }),
    });
  if (group.grants.includes("restore"))
    specs.push({
      action: "restore",
      icon: ArchiveRestore,
      group: "manage",
      label:
        noun === "file"
          ? plural(n, { one: "Restore # file", other: "Restore # files" })
          : plural(n, { one: "Restore # item", other: "Restore # items" }),
    });
  return specs;
}

const SELECTION_GRANTS = ["move", "delete", "restore"] as const satisfies readonly SelectionGrant[];

/**
 * A row's menu, or none when the row has no actions (even inside a selection). Opened on a row
 * inside a selection of two or more, it is the selection's menu and acts on all of it (`run` gets
 * the selection's rows in screen order); opened on a row outside the selection, it selects that row
 * alone and is the row's own menu (`run` gets null). The selection is read once, as the menu opens,
 * so what it acts on is what it named. The row's actions are also what it grants a selection's menu
 * (Move, Delete, Restore; never Rename or creation).
 */
export function useEntryMenu(
  entry: DragEntry,
  actions: readonly EntryAction[],
  run: (action: EntryAction, selection: readonly DragEntry[] | null) => void,
): RowMenu | undefined {
  const selection = useOptionalEntrySelection();
  const [group, setGroup] = useState<SelectionGroup | null>(null);
  // Joined so a caller's fresh array of the same actions doesn't re-register every render.
  const grants = SELECTION_GRANTS.filter((grant) => actions.includes(grant)).join(" ");
  useLayoutEffect(
    () => selection?.grant(entry, grants ? (grants.split(" ") as SelectionGrant[]) : []),
    [selection, entry, grants],
  );
  if (actions.length === 0) return undefined;
  const items = group
    ? selectionActions(group)
    : ENTRY_ACTIONS.filter((spec) => actions.includes(spec.action));
  return {
    groups: menuGroups(items),
    // Trash rows restore; every other list's rows move and delete.
    empty:
      group === null || items.length > 0 ? null : actions.includes("restore") ? (
        <Trans>Can't restore all of these</Trans>
      ) : (
        <Trans>Can't move or delete all of these</Trans>
      ),
    onOpen() {
      const opened = selection?.group(entry) ?? null;
      if (!opened) selection?.pick(entry);
      setGroup(opened);
    },
    onSelect(id) {
      const spec = items.find((candidate) => candidate.action === id);
      if (spec) run(spec.action, group?.entries ?? null);
    },
  };
}

/** Create and manage actions in their own runs; the imports gather under one Import… submenu. */
function menuGroups(specs: readonly EntryActionSpec[]): RowMenuEntry[][] {
  const groups: RowMenuEntry[][] = [];
  let previous: EntryActionSpec | undefined;
  let imports: RowMenuItem[] | null = null;
  for (const spec of specs) {
    if (previous?.group !== spec.group) groups.push([]);
    previous = spec;
    const run = groups.at(-1) as RowMenuEntry[];
    const item = {
      id: spec.action,
      label: spec.label,
      icon: spec.icon,
      destructive: spec.destructive,
    };
    if (!spec.inImportMenu) run.push(item);
    else if (imports) imports.push(item);
    else {
      imports = [item];
      run.push({ id: "import", label: <Trans>Import…</Trans>, icon: ImportIcon, items: imports });
    }
  }
  return groups;
}
