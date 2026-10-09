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
import { ChevronDown, FolderOpen, Pencil } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { useLineageTitle } from "@/client/query/useLineageTitle";
import { useProject } from "@/client/query/useProjectList";
import { useWorks } from "@/client/query/useWorks";
import { type ServerContextTab, type TabOwner, tabContextOwner } from "@/client/stores";
import { type DrillAction, DrillInMenu, type DrillNode } from "@/components/app/DrillInMenu";
import { cn } from "@/lib/utils";
import { useChatScratchSource } from "../chat/use-chat-scratch-source";
import { fileKindIcon } from "../context/context-file-icon";
import { schemeLabel } from "../context/context-schemes";
import { EntryNameField } from "../context/EntryNameField";
import { type ScratchSource, useProjectMenuSource } from "../context/use-catalog-menu-source";
import { useRenameEntryForm } from "../context/use-rename-entry-form";
import { PaneTitle } from "../PaneTitle";
import { displayedChatThreadId, useChatNavigation } from "../routing/chat-navigation";
import { useProjectScreen } from "../routing/ProjectNavigationContext";
import { titleChipClass } from "../shell/title-chip";
import { catalogSiblingNames } from "../work/work-files-model";
import type { DockDocument } from "./dock-view-store";
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

  // The Scratch at the menu's root is the one in view: the chat on screen on the
  // Chat screen, the Work whose Files are open on the Work screen.
  const screen = useProjectScreen();
  const { display } = useChatNavigation();
  const chatScratch = useChatScratchSource(
    projectId,
    screen === "chat" ? displayedChatThreadId(display) : null,
  );
  const workScratchId = screen === "work" ? (tab?.workId ?? null) : null;
  const workScratchName = screen === "work" ? work?.name : undefined;
  const workScratch = useMemo<ScratchSource | null>(
    () =>
      workScratchId
        ? {
            owner: { workId: workScratchId },
            heading: workScratchName ? t`Scratch for ${workScratchName}` : schemeLabel("scratch"),
          }
        : null,
    [workScratchId, workScratchName],
  );
  const project = useProject(projectId);
  const source = useProjectMenuSource({
    projectId,
    title: project?.title ?? "",
    scratch: chatScratch ?? workScratch,
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
