/**
 * A chat's Scratch: the lineage's notes for a No Work chat, the Work's for a
 * chat on a named Work, with any lineage notes left behind by a rebind under
 * "Earlier notes". It always means the chat on screen. Picking a note goes to
 * the Editor. Rows offer Rename, Move… and Delete like any list's while the
 * owner can still be edited; the AI makes the notes, so there is no New note.
 *
 * Two surfaces show it: the Chat list's docked section (`RailScratchSection`) and a
 * chat's Files menu (`MenuScratchSection`). The wording "Scratch for this chat" / "Scratch for
 * <Work>" is the heading's tooltip and accessible name, not a line of text.
 */
import { t } from "@lingui/core/macro";
import type { ContextOwner } from "@meridian/contracts/protocol";
import { isWorkArchived } from "@meridian/contracts/works";
import { Folder, FolderOpen } from "lucide-react";
import { useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useWorks } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { dropdownGroupLabelClass } from "@/components/ui/dropdown-presentation";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { TreeChildren, TreeEnvProvider, TreeGroup } from "../context/ContextTreeRows";
import { schemeIcon, schemeLabel } from "../context/context-schemes";
import type { DragEntry } from "../context/entry-drag/entry";
import type { MoveArea } from "../context/entry-drag/move-plan";
import { EntryList, useEntryList } from "../context/entry-drag/use-entry-list";
import { serverDocumentFromFile } from "../context/open-document-from-file";
import { AreaDropRegion } from "../context/tree-drop/AreaDropRegion";
import { treeFolderIds } from "../context/tree-expansion-state";
import { useDeleteContextEntries } from "../context/use-delete-context-entries";
import type { EntryCapabilities } from "../context/use-entry-interaction";
import { useScratchCatalogs } from "../context/use-scratch-catalogs";
import { useTreeExpansion } from "../context/use-tree-expansion";
import { useOpenDocumentInEditor } from "../routing/use-open-document-in-editor";
import { DockedRailSection } from "../shell/DockedRailSection";
import { useOptionalMainItem } from "../views";
import { useChatScratchSource } from "./use-chat-scratch-source";

/** The document main shows, if any: its row reads as current. */
function useOpenDocumentId(): string | undefined {
  const item = useOptionalMainItem()?.item;
  return item?.kind === "document" ? item.documentId : undefined;
}

/** A chat's Scratch: its catalogs, the list areas they make, and the load state. */
export function useChatScratch(projectId: string, threadId: string | null) {
  const source = useChatScratchSource(projectId, threadId);
  const { primary, earlier } = useScratchCatalogs(projectId, source);
  const { works, noWork } = useWorks(projectId);
  const work =
    source?.owner.workId === noWork?.id
      ? noWork
      : works?.find((work) => work.id === source?.owner.workId);
  // An archived Work's Scratch can be copied from, not changed.
  const editable = !source?.owner.workId || Boolean(work && !isWorkArchived(work));
  const areas = useMemo<MoveArea[]>(
    () => [
      ...(primary.catalog && source
        ? [
            {
              scheme: "scratch" as const,
              owner: source.owner,
              catalog: primary.catalog,
              accepts: editable,
            },
          ]
        : []),
      ...(earlier.catalog && source?.earlierRootThreadId
        ? [
            {
              scheme: "scratch" as const,
              owner: { rootThreadId: source.earlierRootThreadId },
              catalog: earlier.catalog,
              accepts: true,
            },
          ]
        : []),
    ],
    [primary.catalog, earlier.catalog, source, editable],
  );
  const earlierId = source?.earlierRootThreadId;
  const hasEarlier = Boolean(earlierId && earlier.catalog?.files().length);
  const ready = primary.isComplete && (!earlierId || earlier.isComplete);
  const hasRows =
    Boolean(primary.catalog?.children(primary.catalog.root.entryId).length) || hasEarlier;
  return {
    source,
    primary,
    earlier,
    editable,
    areas,
    hasEarlier,
    hasRows,
    ready,
    isError: primary.isError || (Boolean(earlierId) && earlier.isError),
    retry: () => {
      void primary.refetch();
      if (earlierId) void earlier.refetch();
    },
  };
}

type ChatScratch = ReturnType<typeof useChatScratch>;

/** The Chat list's Scratch, docked under the chat list; it collapses, and expanded takes up to 40% of the rail. */
export function RailScratchSection({
  projectId,
  threadId,
  onPicked,
}: {
  projectId: string;
  /** The chat on screen. */
  threadId: string | null;
  /** After a note opens elsewhere (the phone drawer closes). */
  onPicked?: () => void;
}) {
  const scratch = useChatScratch(projectId, threadId);
  const list = useEntryList({ projectId, areas: scratch.areas });
  const { source } = scratch;
  if (!source) return null;
  return (
    <DockedRailSection id="scratch">
      {({ expanded, setExpanded }) => (
        <EntryList list={list}>
          <AreaDropRegion
            scheme="scratch"
            catalogRootId={scratch.primary.catalog?.root.entryId ?? null}
            reveal={() => !expanded && setExpanded(true)}
            className="flex min-h-0 flex-col"
            // A row like Unfiled and Trash below it, not a list heading: it opens and closes
            // the notes above them.
            header={(dropProps) => (
              <div {...dropProps} className="shrink-0">
                <ListRow
                  icon={schemeIcon("scratch")}
                  title={schemeLabel("scratch")}
                  onOpen={() => setExpanded(!expanded)}
                  controlProps={{ "aria-expanded": expanded, title: source.heading }}
                />
              </div>
            )}
          >
            {expanded ? (
              <div className="min-h-0 overflow-y-auto overflow-x-hidden pb-1">
                <div>
                  <TreeGroup depth={1}>
                    <ChatScratchTree
                      projectId={projectId}
                      scratch={scratch}
                      depth={1}
                      onPicked={onPicked}
                    />
                  </TreeGroup>
                </div>
                <ChatScratchStatus scratch={scratch} />
              </div>
            ) : null}
          </AreaDropRegion>
        </EntryList>
      )}
    </DockedRailSection>
  );
}

/**
 * A chat's Scratch in its Files menu: the same rows in their own list, so
 * Move… there ends like everywhere else (its notice shows at the menu's foot).
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
  const scratch = useChatScratch(projectId, threadId);
  const list = useEntryList({ projectId, areas: scratch.areas });
  if (!scratch.source) return null;
  return (
    <section aria-label={scratch.source.heading}>
      <h3 className={dropdownGroupLabelClass}>{scratch.source.heading}</h3>
      <EntryList list={list}>
        <div className="px-2">
          <TreeGroup depth={1}>
            <ChatScratchTree
              projectId={projectId}
              scratch={scratch}
              depth={1}
              onPicked={onPicked}
            />
          </TreeGroup>
        </div>
        <ChatScratchStatus scratch={scratch} />
      </EntryList>
    </section>
  );
}

function ChatScratchStatus({ scratch }: { scratch: ChatScratch }) {
  if (scratch.isError)
    return <InlineErrorRow message={t`Scratch couldn’t load`} onRetry={scratch.retry} />;
  if (scratch.hasRows) return null;
  if (!scratch.ready) return <div aria-busy className="min-h-8" />;
  return <ListLine depth={1} iconSlot>{t`No scratch notes yet.`}</ListLine>;
}

/** A chat's Scratch rows: Earlier notes first, then the current notes, starting at `depth`. */
function ChatScratchTree({
  projectId,
  scratch,
  depth,
  onPicked,
}: {
  projectId: string;
  scratch: ChatScratch;
  depth: number;
  onPicked?: () => void;
}) {
  const { source, primary, earlier, editable, hasEarlier, ready } = scratch;
  const openId = useOpenDocumentId();
  const deleteEntries = useDeleteContextEntries(projectId);
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
    `chat-scratch:${source ? JSON.stringify([source.owner, source.earlierRootThreadId]) : "none"}`,
    folderIds,
  );
  if (!source) return null;
  const earlierOpen = expansion.isExpanded(EARLIER_NOTES_ID);
  return (
    <>
      {hasEarlier && earlier.catalog && source.earlierRootThreadId ? (
        <div>
          <ListRow
            icon={earlierOpen ? FolderOpen : Folder}
            title={t`Earlier notes`}
            depth={depth}
            controlProps={{ "aria-expanded": earlierOpen }}
            onOpen={() => expansion.toggleEntry(EARLIER_NOTES_ID)}
          />
          {earlierOpen ? (
            <TreeGroup depth={depth + 1}>
              <ScratchCatalog
                projectId={projectId}
                catalog={earlier.catalog}
                owner={{ rootThreadId: source.earlierRootThreadId }}
                editable
                depth={depth + 1}
                openId={openId}
                expansion={expansion}
                onPicked={onPicked}
                onRequestDelete={deleteEntries}
              />
            </TreeGroup>
          ) : null}
        </div>
      ) : null}
      {primary.catalog ? (
        <ScratchCatalog
          projectId={projectId}
          catalog={primary.catalog}
          owner={source.owner}
          editable={editable}
          depth={depth}
          openId={openId}
          expansion={expansion}
          onPicked={onPicked}
          onRequestDelete={deleteEntries}
        />
      ) : null}
    </>
  );
}

const EARLIER_NOTES_ID = "earlier:scratch";
const SCRATCH_ACTIONS: EntryCapabilities = ["rename", "move", "copy", "delete"];
const READ_ONLY: EntryCapabilities = ["copy"];

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
  onRequestDelete: (entries: readonly DragEntry[]) => void;
}) {
  const openNote = useOpenDocumentInEditor();
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
      onSelectFile: (_scheme: string, file: Parameters<typeof serverDocumentFromFile>[1]) => {
        const tab = serverDocumentFromFile("scratch", file, owner);
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
