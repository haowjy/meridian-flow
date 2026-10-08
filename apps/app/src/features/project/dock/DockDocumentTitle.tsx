/**
 * DockDocumentTitle — the dock document's title chip and its menu.
 *
 * The chip names the document (icon, name, chevron) in the dock header, the
 * same chip grammar as the chat title beside it. It opens a `DrillInMenu` on the
 * document's own tree (a Work's Scratch or Uploads, as the Work page's Files
 * lists it, or a chat's Scratch, as that chat's header lists it) at the
 * document's folder, so a sibling note is one pick away.
 * Below the tree: Open in Editor and Rename. Rename swaps the chip for the
 * tree row's own inline name field, so a rename here is the one the Files list
 * makes.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkArchived } from "@meridian/contracts/works";
import { ArrowUpRight, ChevronDown, Pencil } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { useLineageTitle } from "@/client/query/useLineageTitle";
import { useWorks } from "@/client/query/useWorks";
import { type TabOwner, tabContextOwner } from "@/client/stores";
import { type DrillAction, DrillInMenu, type DrillNode } from "@/components/app/DrillInMenu";
import { cn } from "@/lib/utils";
import { fileKindIcon } from "../context/context-file-icon";
import { schemeLabel } from "../context/context-schemes";
import { EntryNameField } from "../context/EntryNameField";
import { useCatalogMenuSource } from "../context/use-catalog-menu-source";
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
  const [renaming, setRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The chip comes back after a rename; focus returns to it once it is there.
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (wasRenaming.current && !renaming) triggerRef.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  const work = tab.workId ? works?.find((candidate) => candidate.id === tab.workId) : undefined;
  const archived = work ? isWorkArchived(work) : false;
  // A document's owner names its menu: the Work, or the chat whose Scratch it is.
  const lineageTitle = useLineageTitle(
    projectId,
    tab.rootThreadId ? { rootThreadId: tab.rootThreadId } : null,
  );
  const ownerName = work?.name ?? lineageTitle;
  const heading = ownerName
    ? t`${schemeLabel(tab.scheme)} for ${ownerName}`
    : schemeLabel(tab.scheme);
  const source = useCatalogMenuSource({
    projectId,
    scheme: tab.scheme,
    owner: tabContextOwner(tab),
    heading,
  });
  const { catalog } = source;
  const current = catalog?.findDocument(tab.documentId) ?? null;
  const { foldersOf } = source;
  const openAt = useMemo(() => foldersOf(tab.path), [foldersOf, tab.path]);

  const pick = (node: DrillNode) => {
    const next = source.tabFor(node.id);
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
        owner={tab}
        file={current}
        siblingNames={catalogSiblingNames(catalog, current)}
        onDone={() => setRenaming(false)}
      />
    );

  const Icon = fileKindIcon(tab.name);
  return (
    <DrillInMenu
      tree={source.tree}
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
  owner,
  file,
  siblingNames,
  onDone,
}: {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  owner: TabOwner;
  file: CatalogFile;
  siblingNames: readonly string[];
  onDone: () => void;
}) {
  const form = useRenameEntryForm({
    projectId,
    entryId: file.entryId,
    owner,
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
