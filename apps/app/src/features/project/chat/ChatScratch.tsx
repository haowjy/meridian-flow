/**
 * The chat's Scratch, as a section at the foot of the left rail.
 *
 * `RailScratchSection` is a tree section in the left tree's own style: a head
 * (chevron, Scratch icon, "SCRATCH") that expands upwards or collapses, then
 * the chat's Scratch as tree rows, with folders opening in place. It always
 * means the chat on screen, and lists the chat's Scratch: the lineage's notes
 * for a No Work chat, the Work's for a chat on a named Work, with any lineage
 * notes left behind by a rebind under "Earlier notes". Picking a note opens it
 * beside the chat (`useOpenScratchNote`) and the section stays open. It lists
 * notes only: the AI makes them, and there is no New note. The section shows
 * for every chat, empty or not, so the rail never shifts when the first note
 * lands. The wording "Scratch for this chat" / "Scratch for <Work>" is its
 * tooltip and accessible name rather than a line of text.
 */
import { t } from "@lingui/core/macro";
import { type CSSProperties, useRef, useState } from "react";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import { workFromSnapshot } from "@/client/query/works-projection-acquisition";
import { useContextTabs } from "@/client/stores";
import type { DrillNode, DrillTree } from "@/components/app/DrillInMenu";
import { chatScratchOwner } from "@/features/chat/chat-scratch-owner";
import { schemeIcon, schemeLabel } from "../context/context-schemes";
import { RailPaneHeader } from "../context/RailPaneHeader";
import { useCatalogMenuSource } from "../context/use-catalog-menu-source";
import { useDockViewStore } from "../dock/dock-view-store";
import { useOpenScratchNote } from "../dock/use-open-scratch-note";
import { ResizeHandle } from "../layout/ResizeHandle";
import { useProjectScreen } from "../routing/ProjectNavigationContext";
import { RailEmptyHint, RailFileRow, RailFolderRow } from "../shell/RailSection";
import {
  readScratchExpanded,
  readScratchHeight,
  writeScratchExpanded,
  writeScratchHeight,
} from "./scratch-section-pref";

function useChatScratch(projectId: string, threadId: string | null) {
  const { threads } = useProjectThreads(projectId);
  const { works, noWork } = useWorks(projectId);
  const thread = threadId
    ? (threads?.find((candidate) => candidate.id === threadId) ?? null)
    : null;
  const work =
    thread?.workId && noWork
      ? workFromSnapshot({ works: works ?? [], noWork }, thread.workId)
      : null;
  const owner = chatScratchOwner({ thread, work });
  const source = useCatalogMenuSource({
    projectId,
    owner:
      owner?.kind === "lineage"
        ? { rootThreadId: owner.rootThreadId }
        : { workId: owner?.workId ?? null },
    // A chat rebound onto a Work keeps its lineage's notes findable.
    earlierRootThreadId: owner?.kind === "work" ? (thread?.rootThreadId ?? null) : null,
    // The rail always means the chat on screen, so a chat's own notes need no name.
    heading:
      owner?.kind === "work" && work
        ? t`Scratch for ${work.name}`
        : owner?.kind === "lineage"
          ? t`Scratch for this chat`
          : schemeLabel("scratch"),
  });
  const openNote = useOpenScratchNote();
  if (!owner || !thread) return null;
  return {
    source,
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
  const docked = useDockViewStore((state) =>
    state.occupant?.projectId === projectId ? state.occupant.tab.documentId : undefined,
  );
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
  const [expanded, setExpanded] = useState(readScratchExpanded);
  const [height, setHeight] = useState(readScratchHeight);
  const sectionRef = useRef<HTMLElement | null>(null);
  // Folders the writer has toggled; a top-level folder starts open, like the tree's.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  if (!scratch) return null;
  const { tree } = scratch.source;
  const changeExpanded = (next: boolean) => {
    setExpanded(next);
    writeScratchExpanded(next);
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
            writeScratchHeight(next);
          }}
          onReset={() => {
            setHeight(null);
            writeScratchHeight(null);
          }}
        />
      ) : null}
      {expanded ? (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-1">
          <ScratchRows
            tree={tree}
            folderId={null}
            depth={1}
            openId={openId}
            toggled={toggled}
            onToggle={(id, open) => setToggled((current) => ({ ...current, [id]: !open }))}
            onPick={(node) => {
              if (scratch.pick(node)) onPicked?.();
            }}
          />
        </div>
      ) : null}
      {/* The heading stays at the rail's foot; its notes open upwards above it. */}
      <RailPaneHeader
        label={schemeLabel("scratch")}
        icon={schemeIcon("scratch")}
        title={tree.heading}
        ariaLabel={tree.heading}
        expanded={expanded}
        onExpandedChange={changeExpanded}
        opensUp
      />
    </section>
  );
}

function ScratchRows({
  tree,
  folderId,
  depth,
  openId,
  toggled,
  onToggle,
  onPick,
}: {
  tree: DrillTree;
  folderId: string | null;
  depth: number;
  openId: string | undefined;
  toggled: Record<string, boolean>;
  onToggle: (id: string, open: boolean) => void;
  onPick: (node: DrillNode) => void;
}) {
  const entries = tree.children(folderId);
  if (entries.length === 0)
    return folderId === null ? <RailEmptyHint>{tree.empty}</RailEmptyHint> : null;
  return entries.map((node) => {
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
    const open = toggled[node.id] ?? depth === 1;
    return (
      <div key={node.id}>
        <RailFolderRow
          icon={node.icon}
          name={node.name}
          depth={depth}
          expanded={open}
          onToggle={() => onToggle(node.id, open)}
        />
        {open ? (
          <ScratchRows
            tree={tree}
            folderId={node.id}
            depth={depth + 1}
            openId={openId}
            toggled={toggled}
            onToggle={onToggle}
            onPick={onPick}
          />
        ) : null}
      </div>
    );
  });
}
