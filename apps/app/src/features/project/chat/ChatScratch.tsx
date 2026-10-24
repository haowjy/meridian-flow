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
import { Folder } from "lucide-react";
import { type RefObject, useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useWorks } from "@/client/query/useWorks";
import { useContextTabs } from "@/client/stores";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import type { DeleteTarget } from "../context/ContextEntryActions";
import { TreeChildren, TreeEnvProvider, TreeGroup } from "../context/ContextTreeRows";
import { schemeIcon, schemeLabel } from "../context/context-schemes";
import { serverTabFromFile } from "../context/context-tab-from-file";
import { useDeleteContextEntry } from "../context/document-delete-undo";
import { EntryList, useEntryList } from "../context/entry-drag/use-entry-list";
import { RailPaneHeader } from "../context/RailPaneHeader";
import { AreaDropRegion } from "../context/tree-drop/AreaDropRegion";
import { treeFolderIds } from "../context/tree-expansion-state";
import type { EntryCapabilities } from "../context/use-entry-interaction";
import { useScratchCatalogs } from "../context/use-scratch-catalogs";
import { useTreeExpansion } from "../context/use-tree-expansion";
import { useDockDocument } from "../dock/dock-document-store";
import { useOpenScratchNote } from "../dock/use-open-scratch-note";
import { useProjectScreen } from "../routing/ProjectNavigationContext";
import { DockedRailSection } from "../shell/DockedRailSection";
import { RailEmptyHint, RailFolderRow } from "../shell/RailSection";
import type { NoticeSurface } from "../shell/SurfaceNotice";
import { useChatScratchSource } from "./use-chat-scratch-source";

/** The document open beside the writer, if any: the dock's on the Chat screen, the selected tab in the Editor. */
function useOpenDocumentId(projectId: string, editorWorkId: string | null): string | undefined {
  const screen = useProjectScreen();
  const docked = useDockDocument(screen, projectId)?.tab.documentId;
  const { selectedTabIdByWork } = useContextTabs(projectId);
  if (screen === "chat") return docked;
  if (screen === "context") return selectedTabIdByWork[editorWorkId ?? ""] ?? undefined;
  return undefined;
}

export function RailScratchSection({
  projectId,
  threadId,
  editorWorkId,
  onPicked,
  resizeAgainst,
}: {
  projectId: string;
  /** The chat on screen: the centre chat on the Chat screen, the dock's chat elsewhere. */
  threadId: string | null;
  editorWorkId: string | null;
  /** Called after a note is picked (the phone drawer closes over the document). */
  onPicked?: () => void;
  /**
   * Desktop only: the pane above, which a handle on the divider trades height
   * with when the section is expanded.
   */
  resizeAgainst?: RefObject<HTMLElement | null>;
}) {
  const scratch = useChatScratchSource(projectId, threadId);
  const { list, primary } = useChatScratchList(projectId, scratch, "sidebar");
  if (!scratch) return null;
  return (
    <DockedRailSection id="scratch" resizeAgainst={resizeAgainst}>
      {({ expanded, setExpanded }) => (
        <EntryList list={list}>
          <AreaDropRegion
            scheme="scratch"
            catalogRootId={primary.catalog?.root.entryId ?? null}
            reveal={() => !expanded && setExpanded(true)}
            className="flex min-h-0 flex-col"
            header={(dropProps) => (
              <RailPaneHeader
                label={schemeLabel("scratch")}
                icon={schemeIcon("scratch")}
                title={scratch.heading}
                ariaLabel={scratch.heading}
                expanded={expanded}
                onExpandedChange={setExpanded}
                dropProps={dropProps}
              />
            )}
          >
            {expanded ? (
              <div className="min-h-0 overflow-y-auto overflow-x-hidden pb-1">
                <ChatScratchTree
                  projectId={projectId}
                  threadId={threadId}
                  editorWorkId={editorWorkId}
                  onPicked={onPicked}
                />
              </div>
            ) : null}
          </AreaDropRegion>
        </EntryList>
      )}
    </DockedRailSection>
  );
}

/** One list over a chat's Scratch: its current catalog and its Earlier notes. */
function useChatScratchList(
  projectId: string,
  scratch: ReturnType<typeof useChatScratchSource>,
  surface: NoticeSurface,
) {
  const { primary, earlier, editable } = useChatScratchCatalogs(projectId, scratch);
  const areas = useMemo(
    () => [
      ...(primary.catalog && scratch
        ? [
            {
              scheme: "scratch" as const,
              owner: scratch.owner,
              catalog: primary.catalog,
              movable: editable,
            },
          ]
        : []),
      ...(earlier.catalog && scratch?.earlierRootThreadId
        ? [
            {
              scheme: "scratch" as const,
              owner: { rootThreadId: scratch.earlierRootThreadId },
              catalog: earlier.catalog,
              movable: true,
            },
          ]
        : []),
    ],
    [primary.catalog, earlier.catalog, scratch, editable],
  );
  return { list: useEntryList({ projectId, surface, areas }), primary };
}

/**
 * A chat's Scratch in its Files menu: the same rows as the rail in its own list,
 * so Move… there ends like everywhere else (its notice shows at the menu's foot).
 */
export function MenuScratchSection({
  projectId,
  threadId,
  onPicked,
}: {
  projectId: string;
  threadId: string | null;
  onPicked?: () => void;
}) {
  const scratch = useChatScratchSource(projectId, threadId);
  const { list } = useChatScratchList(projectId, scratch, "chat-files");
  if (!scratch) return null;
  return (
    <section aria-label={scratch.heading}>
      <h3 className="px-3 py-2 text-xs font-medium text-muted-foreground">{scratch.heading}</h3>
      <EntryList list={list}>
        <ChatScratchTree
          projectId={projectId}
          threadId={threadId}
          onPicked={onPicked}
          surface="chat-files"
        />
      </EntryList>
    </section>
  );
}

/** The chat's Scratch catalogs, and whether its owner still accepts edits. */
function useChatScratchCatalogs(
  projectId: string,
  scratch: ReturnType<typeof useChatScratchSource>,
) {
  const { primary, earlier } = useScratchCatalogs(projectId, scratch);
  const { works, noWork } = useWorks(projectId);
  const work =
    scratch?.owner.workId === noWork?.id
      ? noWork
      : works?.find((work) => work.id === scratch?.owner.workId);
  const editable = !scratch?.owner.workId || Boolean(work && !isWorkArchived(work));
  return { primary, earlier, editable };
}

/**
 * Shared Scratch rows for the rail, phone drawer and chat Files menu; each
 * surface wraps them in its own list.
 */
function ChatScratchTree({
  projectId,
  threadId,
  editorWorkId = null,
  onPicked,
  surface = "sidebar",
}: {
  projectId: string;
  threadId: string | null;
  editorWorkId?: string | null;
  onPicked?: () => void;
  surface?: NoticeSurface;
}) {
  const scratch = useChatScratchSource(projectId, threadId);
  const { primary, earlier, editable } = useChatScratchCatalogs(projectId, scratch);
  const openId = useOpenDocumentId(projectId, editorWorkId);
  const deletion = useDeleteContextEntry(surface);
  const hasEarlier = Boolean(scratch?.earlierRootThreadId && earlier.catalog?.files().length);
  const ready = primary.isComplete && (!scratch?.earlierRootThreadId || earlier.isComplete);
  const isError = primary.isError || (Boolean(scratch?.earlierRootThreadId) && earlier.isError);
  const folderIds = useMemo(() => {
    if (!ready) return null;
    const folders = (catalog: CatalogContextView | null) =>
      catalog
        ? treeFolderIds((parent) =>
            catalog
              .children(parent ?? catalog.root.entryId)
              .filter((node) => node.kind === "dir")
              .map((node) => node.entryId),
          )
        : [];
    return [
      ...folders(primary.catalog),
      ...(hasEarlier ? [EARLIER_NOTES_ID, ...folders(earlier.catalog)] : []),
    ];
  }, [ready, primary.catalog, earlier.catalog, hasEarlier]);
  const expansion = useTreeExpansion(
    projectId,
    `chat-scratch:${scratch ? JSON.stringify([scratch.owner, scratch.earlierRootThreadId]) : "none"}`,
    folderIds,
  );
  if (!scratch) return <div aria-busy className="min-h-8" />;
  const hasRows =
    Boolean(primary.catalog?.children(primary.catalog.root.entryId).length) || hasEarlier;
  return (
    <>
      <TreeGroup depth={1}>
        {hasEarlier && earlier.catalog && scratch.earlierRootThreadId ? (
          <div>
            <RailFolderRow
              icon={Folder}
              name={t`Earlier notes`}
              depth={1}
              expanded={expansion.isExpanded(EARLIER_NOTES_ID)}
              onToggle={() => expansion.toggleEntry(EARLIER_NOTES_ID)}
            />
            {expansion.isExpanded(EARLIER_NOTES_ID) ? (
              <TreeGroup depth={2}>
                <ScratchCatalog
                  projectId={projectId}
                  catalog={earlier.catalog}
                  owner={{ rootThreadId: scratch.earlierRootThreadId }}
                  editable
                  depth={2}
                  openId={openId}
                  expansion={expansion}
                  onPicked={onPicked}
                  onRequestDelete={deletion.requestDelete}
                />
              </TreeGroup>
            ) : null}
          </div>
        ) : null}
        {primary.catalog ? (
          <ScratchCatalog
            projectId={projectId}
            catalog={primary.catalog}
            owner={scratch.owner}
            editable={editable}
            depth={1}
            openId={openId}
            expansion={expansion}
            onPicked={onPicked}
            onRequestDelete={deletion.requestDelete}
          />
        ) : null}
      </TreeGroup>
      {!hasRows && ready ? <RailEmptyHint>{t`No scratch notes yet.`}</RailEmptyHint> : null}
      {!hasRows && !ready && !isError ? <div aria-busy className="min-h-8" /> : null}
      {isError ? (
        <InlineErrorRow
          message={t`Scratch couldn’t load`}
          onRetry={() => {
            void primary.refetch();
            if (scratch.earlierRootThreadId) void earlier.refetch();
          }}
        />
      ) : null}
    </>
  );
}

const EARLIER_NOTES_ID = "earlier:scratch";
const SCRATCH_ACTIONS: EntryCapabilities = ["rename", "move", "delete"];
const READ_ONLY: EntryCapabilities = [];

/** One real owner per tree; the Earlier notes disclosure is outside both catalogs. */
function ScratchCatalog({
  projectId,
  catalog,
  owner,
  editable,
  depth,
  openId,
  expansion,
  onPicked,
  onRequestDelete,
}: {
  projectId: string;
  catalog: CatalogContextView;
  owner: ContextOwner;
  editable: boolean;
  depth: number;
  openId: string | undefined;
  expansion: Pick<ReturnType<typeof useTreeExpansion>, "isExpanded" | "toggleEntry">;
  onPicked?: () => void;
  onRequestDelete: (target: DeleteTarget) => void;
}) {
  const openNote = useOpenScratchNote();
  const { isExpanded, toggleEntry } = expansion;
  const env = useMemo(
    () => ({
      projectId,
      scheme: "scratch" as const,
      owner,
      capabilities: editable ? SCRATCH_ACTIONS : READ_ONLY,
      catalog,
      activeScheme: "scratch" as const,
      activePath: catalog.findDocument(openId ?? "")?.path ?? null,
      onSelectFile: (_scheme: string, file: Parameters<typeof serverTabFromFile>[1]) => {
        const tab = serverTabFromFile("scratch", file, owner);
        if (!tab) return;
        openNote(tab);
        onPicked?.();
      },
      onRequestDelete,
      isExpanded,
      toggleEntry,
    }),
    [
      projectId,
      owner,
      editable,
      catalog,
      openId,
      openNote,
      onPicked,
      onRequestDelete,
      isExpanded,
      toggleEntry,
    ],
  );
  return (
    <TreeEnvProvider value={env}>
      <TreeChildren parentId={catalog.root.entryId} parentPath="" depth={depth} />
    </TreeEnvProvider>
  );
}
