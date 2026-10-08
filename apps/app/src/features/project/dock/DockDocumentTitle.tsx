/**
 * DockDocumentTitle — the dock document's title chip and its menu.
 *
 * The chip names the document (icon, name, chevron) in the dock header, the
 * same chip grammar as the chat title beside it. It opens a `DrillInMenu` on the
 * document's own tree (a Work's Scratch or Uploads, as the Work page's Files
 * lists it) at the document's folder, so a sibling note is one pick away.
 * Below the tree: Open in Editor and Rename. Rename swaps the chip for the
 * tree row's own inline name field, so a rename here is the one the Files list
 * makes.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkArchived } from "@meridian/contracts/works";
import { ArrowUpRight, ChevronDown, Folder, Pencil } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { useWorks } from "@/client/query/useWorks";
import { type DrillAction, DrillInMenu, type DrillNode } from "@/components/app/DrillInMenu";
import { cn } from "@/lib/utils";
import { fileKindIcon } from "../context/context-file-icon";
import { schemeLabel } from "../context/context-schemes";
import { serverTabFromFile } from "../context/context-tab-from-file";
import { EntryNameField } from "../context/EntryNameField";
import { useRenameEntryForm } from "../context/use-rename-entry-form";
import { PaneTitle } from "../PaneTitle";
import { useOpenDocumentInEditor } from "../routing/use-open-document-in-editor";
import { titleChipClass } from "../shell/title-chip";
import { catalogSiblingNames } from "../work/work-files-model";
import { type DockDocument, useDockViewStore } from "./dock-view-store";
import { useDockDocumentTab } from "./use-dock-document-tab";
import { useOpenDocumentInDock } from "./use-open-document-in-dock";

export function DockDocumentTitle({
  projectId,
  document: dockDocument,
}: {
  projectId: string;
  document: DockDocument;
}) {
  const { tab } = useDockDocumentTab(projectId, dockDocument);
  const closeDocument = useDockViewStore((state) => state.closeDocument);
  const openInEditor = useOpenDocumentInEditor();
  const openInDock = useOpenDocumentInDock();
  const { works } = useWorks(projectId);
  const { catalog } = useContextCatalogView(projectId, tab.scheme, { workId: tab.workId ?? null });
  const [renaming, setRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const work = tab.workId ? works?.find((candidate) => candidate.id === tab.workId) : undefined;
  const archived = work ? isWorkArchived(work) : false;
  const current = catalog?.findDocument(tab.documentId) ?? null;
  const heading = work ? t`${schemeLabel(tab.scheme)} for ${work.name}` : schemeLabel(tab.scheme);

  const tree = useMemo(
    () => ({
      heading,
      children: (folderId: string | null): DrillNode[] => {
        if (!catalog) return [];
        return catalog
          .children(folderId ?? catalog.root.entryId)
          .map((node) => ({
            id: node.entryId,
            name: node.name,
            folder: node.kind === "dir",
            icon: node.kind === "dir" ? Folder : fileKindIcon(node),
          }))
          .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
      },
    }),
    [catalog, heading],
  );
  const openAt = useMemo(() => {
    if (!catalog) return [];
    const folders = tab.path.split("/").filter(Boolean).slice(0, -1);
    return folders.flatMap((_, index) => {
      const folder = catalog.findPath(`/${folders.slice(0, index + 1).join("/")}`);
      return folder?.kind === "dir"
        ? [{ id: folder.entryId, name: folder.name, folder: true, icon: Folder }]
        : [];
    });
  }, [catalog, tab.path]);

  const pick = (node: DrillNode) => {
    const file = catalog?.files().find((candidate) => candidate.entryId === node.id);
    if (!file) return;
    const next = serverTabFromFile(tab.scheme, file, tab.workId);
    if (next) openInDock(next);
  };

  const actions: DrillAction[] = [
    {
      key: "open-in-editor",
      label: t`Open in Editor`,
      icon: ArrowUpRight,
      onSelect: () => {
        closeDocument();
        openInEditor(tab);
      },
    },
    ...(current && !archived
      ? [{ key: "rename", label: t`Rename`, icon: Pencil, onSelect: () => setRenaming(true) }]
      : []),
  ];

  if (renaming && current)
    return (
      <DockDocumentRename
        projectId={projectId}
        scheme={tab.scheme}
        workId={tab.workId ?? null}
        file={current}
        siblingNames={catalogSiblingNames(catalog, current)}
        onDone={() => {
          setRenaming(false);
          triggerRef.current?.focus();
        }}
      />
    );

  const Icon = fileKindIcon(tab.name);
  return (
    <DrillInMenu
      tree={tree}
      currentId={current?.entryId ?? null}
      openAt={openAt}
      actions={actions}
      onPick={pick}
    >
      <button
        ref={triggerRef}
        type="button"
        className={cn("focus-ring text-left", titleChipClass("quiet"))}
      >
        <Icon className="size-4 shrink-0 text-ink-subtle" aria-hidden />
        <PaneTitle className="min-w-0 flex-1 px-0">{tab.name}</PaneTitle>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    </DrillInMenu>
  );
}

function DockDocumentRename({
  projectId,
  scheme,
  workId,
  file,
  siblingNames,
  onDone,
}: {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  workId: string | null;
  file: CatalogFile;
  siblingNames: readonly string[];
  onDone: () => void;
}) {
  const form = useRenameEntryForm({
    projectId,
    entryId: file.entryId,
    workId,
    scheme,
    path: file.path,
    currentName: file.name,
    repairName: file.namespaceRepairName,
    siblingNames,
    kind: "file",
    onDone,
  });
  return <EntryNameField form={form} label={t`File name`} />;
}
