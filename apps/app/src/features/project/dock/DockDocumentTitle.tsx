/**
 * DockDocumentTitle — the dock document's title chip and its menu.
 *
 * The chip names the document (icon, name, chevron) in the dock header, the
 * same chip grammar as the chat title beside it. It opens a `DrillInMenu` at
 * the document's own folder; back rows climb to the project's areas, so any
 * document is a few picks away. Below the tree: Rename (Open in Editor is the
 * header's own button). Rename swaps the chip for the
 * tree row's own inline name field, so a rename here is the one the Files list
 * makes.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkArchived } from "@meridian/contracts/works";
import { ChevronDown, FolderOpen, Pencil } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { useLineageTitle } from "@/client/query/useLineageTitle";
import { useProject } from "@/client/query/useProjectList";
import { useWorks } from "@/client/query/useWorks";
import { type ServerContextTab, type TabOwner, tabContextOwner } from "@/client/stores";
import { type DrillAction, DrillInMenu, type DrillNode } from "@/components/app/DrillInMenu";
import { cn } from "@/lib/utils";
import { fileKindIcon } from "../context/context-file-icon";
import { schemeLabel } from "../context/context-schemes";
import { EntryNameField } from "../context/EntryNameField";
import { useProjectMenuSource } from "../context/use-catalog-menu-source";
import { useRenameEntryForm } from "../context/use-rename-entry-form";
import { PaneTitle } from "../PaneTitle";
import { titleChipClass } from "../shell/title-chip";
import { catalogSiblingNames } from "../work/work-files-model";
import type { DockDocument } from "./dock-view-store";
import { useDockBrowseScratch } from "./use-dock-browse-scratch";
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
  if (tab.kind === "new") return <PaneTitle>{tab.name}</PaneTitle>;
  return <DockTitleMenu projectId={projectId} tab={tab} />;
}

/**
 * The one title chip and menu. With a document it names it and opens at its
 * folder, with Rename; with none (the Chat screen's rail) it reads "Open
 * document", opens at the root, and has no actions.
 */
export function DockTitleMenu({
  projectId,
  tab,
}: {
  projectId: string;
  tab: ServerContextTab | null;
}) {
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

  const work = tab?.workId ? works?.find((candidate) => candidate.id === tab.workId) : undefined;
  const archived = work ? isWorkArchived(work) : false;
  // A document's owner names its own area: the Work, or the chat whose Scratch it is.
  const lineageTitle = useLineageTitle(
    projectId,
    tab?.rootThreadId ? { rootThreadId: tab.rootThreadId } : null,
  );
  const ownerName = work?.name ?? lineageTitle;
  const documentHeading = !tab
    ? ""
    : ownerName
      ? t`${schemeLabel(tab.scheme)} for ${ownerName}`
      : schemeLabel(tab.scheme);

  // The Scratch at the menu's root is the one on screen; the document's own area is separate.
  const scratch = useDockBrowseScratch(projectId);
  const project = useProject(projectId);
  const source = useProjectMenuSource({
    projectId,
    title: project?.title ?? "",
    scratch,
    document: tab
      ? { scheme: tab.scheme, owner: tabContextOwner(tab), heading: documentHeading }
      : null,
  });
  const { catalog } = source.own;
  const current = tab ? (catalog?.findDocument(tab.documentId) ?? null) : null;
  const openAt = useMemo(() => (tab ? source.own.openAt(tab.path) : []), [source.own, tab]);

  const pick = (node: DrillNode) => {
    const next = source.tabFor(node.id);
    if (next) openInDock(next);
  };

  const actions: DrillAction[] = [
    ...(current && !archived
      ? [{ key: "rename", label: t`Rename`, icon: Pencil, onSelect: () => setRenaming(true) }]
      : []),
  ];

  if (renaming && current && tab)
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

  const Icon = tab ? fileKindIcon(tab.name) : FolderOpen;
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
        <PaneTitle className="min-w-0 flex-1 px-0">{tab ? tab.name : t`Open document`}</PaneTitle>
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
