/**
 * The chat's Scratch, as a section at the foot of the left rail.
 *
 * `RailScratchSection` is a tree section in the left tree's own style: a head
 * (chevron, Scratch icon, "SCRATCH") that expands upwards or collapses, then
 * the chat's Scratch as tree rows, with folders opening in place. It always
 * means the chat on screen, and lists the chat's Scratch: the lineage's notes
 * for a No Work chat, the Work's for a chat on a named Work, with any lineage
 * notes left behind by a rebind under "Earlier notes". Picking a note opens it
 * beside the chat (`useOpenScratchNote`) and the section stays open. Rows offer
 * Rename, Move… and Delete like any list's, while the owner can still be edited;
 * the AI makes the notes, so there is no New note. The section shows
 * for every chat, empty or not, so the rail never shifts when the first note
 * lands. The wording "Scratch for this chat" / "Scratch for <Work>" is its
 * tooltip and accessible name rather than a line of text.
 */
import { t } from "@lingui/core/macro";
import type { ContextOwner } from "@meridian/contracts/protocol";
import { isWorkArchived } from "@meridian/contracts/works";
import { type CSSProperties, useMemo, useRef } from "react";
import { useWorks } from "@/client/query/useWorks";
import { useContextTabs } from "@/client/stores";
import type { DrillNode, DrillTree } from "@/components/app/DrillInMenu";
import {
  DeleteConfirmationDialog,
  type DeleteTarget,
  useDeleteConfirmation,
} from "../context/ContextEntryActions";
import { ContextTreeEntry, TreeEnvProvider } from "../context/ContextTreeRows";
import { fileKindIcon as nodeIcon } from "../context/context-file-icon";
import { schemeIcon, schemeLabel } from "../context/context-schemes";
import { RailPaneHeader } from "../context/RailPaneHeader";
import { treeFolderIds } from "../context/tree-expansion-state";
import { type CatalogMenuSource, useCatalogMenuSource } from "../context/use-catalog-menu-source";
import type { EntryCapabilities } from "../context/use-entry-interaction";
import { useTreeExpansion } from "../context/use-tree-expansion";
import { useDockDocument } from "../dock/dock-view-store";
import { useOpenScratchNote } from "../dock/use-open-scratch-note";
import { ResizeHandle } from "../layout/ResizeHandle";
import { useProjectSurfacePrefsStore } from "../layout/surface-prefs-store";
import { useProjectScreen } from "../routing/ProjectNavigationContext";
import { RailEmptyHint, RailFileRow, RailFolderRow } from "../shell/RailSection";
import { useChatScratchSource } from "./use-chat-scratch-source";

function useChatScratch(projectId: string, threadId: string | null) {
  const scratch = useChatScratchSource(projectId, threadId);
  const source = useCatalogMenuSource({
    projectId,
    owner: scratch?.owner ?? {},
    earlierRootThreadId: scratch?.earlierRootThreadId,
    heading: scratch?.heading ?? schemeLabel("scratch"),
  });
  const openNote = useOpenScratchNote();
  if (!scratch) return null;
  return {
    source,
    scope: JSON.stringify([scratch.owner, scratch.earlierRootThreadId]),
    pick: (node: DrillNode) => {
      const tab = source.tabFor(node.id);
      if (!tab) return false;
      openNote(tab);
      return true;
    },
  };
}

/** The document open beside the writer, if any: the dock's on the Chat screen, the selected tab in the Editor. */
function useOpenDocumentId(projectId: string, editorWorkId: string | null): string | undefined {
  const screen = useProjectScreen();
  const docked = useDockDocument(screen, projectId)?.tab.documentId;
  const { selectedTabIdByWork } = useContextTabs(projectId);
  if (screen === "chat") return docked;
  if (screen === "context") return selectedTabIdByWork[editorWorkId ?? ""] ?? undefined;
  return undefined;
}

/** Each pane keeps this much when the writer resizes between the tree and Scratch. */
const MIN_PANE_PX = 120;
const HEIGHT_VAR = "--scratch-section-height";

export function RailScratchSection({
  projectId,
  threadId,
  editorWorkId,
  onPicked,
  resizable = false,
}: {
  projectId: string;
  /** The chat on screen: the centre chat on the Chat screen, the dock's chat elsewhere. */
  threadId: string | null;
  editorWorkId: string | null;
  /** Called after a note is picked (the phone drawer closes over the document). */
  onPicked?: () => void;
  /** Desktop only: a handle on the divider above the expanded section resizes it. */
  resizable?: boolean;
}) {
  const scratch = useChatScratch(projectId, threadId);
  const openId = useOpenDocumentId(projectId, editorWorkId);
  const expanded = useProjectSurfacePrefsStore((state) => state.railPrefs.scratchExpanded);
  const height = useProjectSurfacePrefsStore((state) => state.railPrefs.scratchHeight);
  const setExpanded = useProjectSurfacePrefsStore((state) => state.setRailExpanded);
  const setHeight = useProjectSurfacePrefsStore((state) => state.setScratchHeight);
  const sectionRef = useRef<HTMLElement | null>(null);
  const deletion = useDeleteConfirmation({ projectId });
  const { works, noWork } = useWorks(projectId);
  const capabilitiesByOwner = new Map<string, EntryCapabilities>();
  const capabilitiesFor = (owner: ContextOwner): EntryCapabilities => {
    const key = owner.rootThreadId ? `lineage:${owner.rootThreadId}` : `work:${owner.workId ?? ""}`;
    const cached = capabilitiesByOwner.get(key);
    if (cached) return cached;
    const work =
      owner.workId === noWork?.id ? noWork : works?.find((work) => work.id === owner.workId);
    const actions: EntryCapabilities =
      !owner.workId || (work && !isWorkArchived(work)) ? ["rename", "move", "delete"] : [];
    capabilitiesByOwner.set(key, actions);
    return actions;
  };
  const folderIds = useMemo(
    () =>
      scratch?.source.ready
        ? treeFolderIds((parent) =>
            scratch.source.tree
              .children(parent)
              .filter((node) => node.folder)
              .map((node) => node.id),
          )
        : null,
    [scratch?.source.ready, scratch?.source.tree],
  );
  const { isExpanded, toggleEntry } = useTreeExpansion(
    projectId,
    `chat-scratch:${scratch?.scope ?? "none"}`,
    folderIds,
  );
  if (!scratch) return null;
  const { tree } = scratch.source;
  const changeExpanded = (next: boolean) => {
    setExpanded("scratch", next);
  };
  return (
    <section
      ref={sectionRef}
      className="relative flex min-h-0 shrink flex-col border-t border-border-subtle py-1"
      // Content-sized up to 40% of the rail by default; the handle's variable (set live
      // while dragging, and from the saved height) replaces both.
      style={
        expanded
          ? ({
              height: `var(${HEIGHT_VAR}, auto)`,
              maxHeight: `max(40%, var(${HEIGHT_VAR}, 0px))`,
              minHeight: height === null ? undefined : MIN_PANE_PX,
              ...(height === null ? {} : { [HEIGHT_VAR]: `${height}px` }),
            } as CSSProperties)
          : undefined
      }
    >
      {resizable && expanded ? (
        <ResizeHandle
          gridRef={sectionRef}
          cssVariableName={HEIGHT_VAR}
          widthPx={height}
          minWidthPx={MIN_PANE_PX}
          maxWidthPx={Number.MAX_SAFE_INTEGER}
          orientation="vertical"
          dragDirection={-1}
          ariaLabel={t`Resize Scratch`}
          measure={() => {
            const section = sectionRef.current;
            const tree = section?.previousElementSibling;
            const own = section?.getBoundingClientRect().height ?? MIN_PANE_PX;
            const above = tree?.getBoundingClientRect().height ?? 0;
            return { value: own, min: MIN_PANE_PX, max: own + above - MIN_PANE_PX };
          }}
          onCommit={(next) => {
            setHeight(next);
          }}
          onReset={() => {
            setHeight(null);
          }}
        />
      ) : null}
      <RailPaneHeader
        label={schemeLabel("scratch")}
        icon={schemeIcon("scratch")}
        title={tree.heading}
        ariaLabel={tree.heading}
        expanded={expanded}
        onExpandedChange={changeExpanded}
      />
      {expanded ? (
        <div className="min-h-0 overflow-y-auto overflow-x-hidden pb-1">
          <ScratchRows
            projectId={projectId}
            onRequestDelete={deletion.requestDelete}
            capabilitiesFor={capabilitiesFor}
            source={scratch.source}
            tree={tree}
            folderId={null}
            depth={1}
            openId={openId}
            isExpanded={isExpanded}
            onToggle={toggleEntry}
            onPick={(node) => {
              if (scratch.pick(node)) onPicked?.();
            }}
          />
        </div>
      ) : null}
      <DeleteConfirmationDialog
        target={deletion.target}
        isPending={deletion.isPending}
        error={deletion.error}
        onCancel={deletion.cancel}
        onConfirm={() => void deletion.confirm()}
      />
    </section>
  );
}

function ScratchRows({
  projectId,
  source,
  tree,
  folderId,
  depth,
  openId,
  isExpanded,
  onToggle,
  onPick,
  onRequestDelete,
  capabilitiesFor,
}: {
  onRequestDelete: (target: DeleteTarget) => void;
  capabilitiesFor: (owner: ContextOwner) => EntryCapabilities;
  projectId: string;
  source: CatalogMenuSource;
  tree: DrillTree;
  folderId: string | null;
  depth: number;
  openId: string | undefined;
  isExpanded: (id: string) => boolean;
  onToggle: (id: string) => void;
  onPick: (node: DrillNode) => void;
}) {
  const entries = tree.children(folderId);
  if (entries.length === 0)
    return folderId === null ? <RailEmptyHint>{tree.empty}</RailEmptyHint> : null;
  return entries.map((node) => {
    const entry = source.entryFor(node.id);
    if (entry)
      return (
        <ScratchEntry
          key={node.id}
          projectId={projectId}
          capabilities={capabilitiesFor(entry.owner)}
          onRequestDelete={onRequestDelete}
          entry={entry}
          depth={depth}
          openId={openId}
          isExpanded={isExpanded}
          onToggle={onToggle}
          onPick={onPick}
        />
      );
    if (!node.folder)
      return (
        <RailFileRow
          key={node.id}
          icon={node.icon}
          name={node.name}
          depth={depth}
          active={openId !== undefined && (node.documentId ?? node.id) === openId}
          onOpen={() => onPick(node)}
        />
      );
    const open = isExpanded(node.id);
    return (
      <div key={node.id}>
        <RailFolderRow
          icon={node.icon}
          name={node.name}
          depth={depth}
          expanded={open}
          onToggle={() => onToggle(node.id)}
        />
        {open ? (
          <ScratchRows
            projectId={projectId}
            onRequestDelete={onRequestDelete}
            capabilitiesFor={capabilitiesFor}
            source={source}
            tree={tree}
            folderId={node.id}
            depth={depth + 1}
            openId={openId}
            isExpanded={isExpanded}
            onToggle={onToggle}
            onPick={onPick}
          />
        ) : null}
      </div>
    );
  });
}

/** Actual Scratch entries share the Files row forms, actions and optimistic namespace owner. */
function ScratchEntry({
  projectId,
  entry,
  depth,
  openId,
  isExpanded,
  onToggle,
  onPick,
  capabilities,
  onRequestDelete,
}: {
  capabilities: EntryCapabilities;
  onRequestDelete: (target: DeleteTarget) => void;
  projectId: string;
  entry: NonNullable<ReturnType<CatalogMenuSource["entryFor"]>>;
  depth: number;
  openId: string | undefined;
  isExpanded: (id: string) => boolean;
  onToggle: (id: string) => void;
  onPick: (node: DrillNode) => void;
}) {
  return (
    <TreeEnvProvider
      value={{
        projectId,
        scheme: "scratch",
        owner: entry.owner,
        capabilities,
        catalog: entry.catalog,
        activeScheme: "scratch",
        activePath: entry.catalog.findDocument(openId ?? "")?.path ?? null,
        onSelectFile: (_scheme, file) => {
          // Descendant rows resolve their own node through the rail's canonical opener.
          onPick({
            id: file.entryId,
            documentId: file.documentId,
            name: file.name,
            icon: nodeIcon(file),
            folder: false,
          });
        },
        onRequestDelete,
        isExpanded,
        toggleEntry: onToggle,
      }}
    >
      <ContextTreeEntry
        node={entry.node}
        depth={depth}
        siblings={entry.catalog.children(entry.node.parentId ?? entry.catalog.root.entryId)}
      />
    </TreeEnvProvider>
  );
}
