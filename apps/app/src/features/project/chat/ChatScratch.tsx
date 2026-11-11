/**
 * A chat's Scratch: the lineage's notes for a No Work chat, the Work's for a
 * chat on a named Work, with any lineage notes left behind by a rebind under
 * "Earlier notes". It always means the chat on screen. Picking a note goes to
 * the Editor. Rows offer Rename, Move… and Delete like any list's while the
 * owner can still be edited; the AI makes the notes, so there is no New note.
 *
 * Three surfaces show it: the Files list's Scratch source (`ScratchSource`), the
 * Chat list's docked section (`RailScratchSection`), and a chat's Files menu
 * (`MenuScratchSection`). The wording "Scratch for this chat" / "Scratch for
 * <Work>" is the heading's tooltip and accessible name, not a line of text.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ContextOwner } from "@meridian/contracts/protocol";
import { isWorkArchived } from "@meridian/contracts/works";
import { Folder, FolderOpen } from "lucide-react";
import { type RefObject, useMemo } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useWorks } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { dropdownGroupLabelClass } from "@/components/ui/dropdown-presentation";
import type { DeleteTarget } from "../context/ContextEntryActions";
import { TreeChildren, TreeEnvProvider, TreeGroup } from "../context/ContextTreeRows";
import { schemeIcon, schemeLabel } from "../context/context-schemes";
import type { MoveArea } from "../context/entry-drag/move-plan";
import { EntryList, useEntryList } from "../context/entry-drag/use-entry-list";
import { serverDocumentFromFile } from "../context/open-document-from-file";
import { RailPaneHeader } from "../context/RailPaneHeader";
import { AreaDropRegion } from "../context/tree-drop/AreaDropRegion";
import { treeFolderIds } from "../context/tree-expansion-state";
import { useDeleteContextEntry } from "../context/use-delete-context-entry";
import type { EntryCapabilities } from "../context/use-entry-interaction";
import { useScratchCatalogs } from "../context/use-scratch-catalogs";
import { useTreeExpansion } from "../context/use-tree-expansion";
import { useOpenDocumentInEditor } from "../routing/use-open-document-in-editor";
import { DockedRailSection } from "../shell/DockedRailSection";
import { RailEmptyHint, RailFolderRow } from "../shell/RailSection";
import { type SourceDrop, SourceHint, SourcePane } from "../shell/sidebar/SourcePane";
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

/**
 * Write's Scratch source: the chat on screen's notes as flush rows, under the
 * same heading as every other source. Its rows sit in the sidebar's one list,
 * which `scratch.areas` joins.
 */
export function ScratchSource({
  projectId,
  scratch,
  onPicked,
  drop,
}: {
  projectId: string;
  scratch: ChatScratch;
  onPicked?: () => void;
  drop: SourceDrop;
}) {
  return (
    <SourcePane label={schemeLabel("scratch")} title={scratch.source?.heading} drop={drop}>
      {scratch.source ? (
        <ChatScratchTree projectId={projectId} scratch={scratch} depth={0} onPicked={onPicked} />
      ) : null}
      {!scratch.source ? (
        <SourceHint>
          <Trans>Open a chat to see its Scratch.</Trans>
        </SourceHint>
      ) : scratch.isError ? (
        <InlineErrorRow message={t`Scratch couldn’t load`} onRetry={scratch.retry} />
      ) : !scratch.ready ? (
        <SourceHint status>
          <Trans>Loading…</Trans>
        </SourceHint>
      ) : !scratch.hasRows ? (
        <SourceHint>
          <Trans>No scratch notes yet.</Trans>
        </SourceHint>
      ) : null}
    </SourcePane>
  );
}

/** The Chat list's Scratch, docked under the chat list; it collapses and trades height with the list. */
export function RailScratchSection({
  projectId,
  threadId,
  resizeAgainst,
  onPicked,
}: {
  projectId: string;
  /** The chat on screen. */
  threadId: string | null;
  /** After a note opens elsewhere (the phone drawer closes). */
  onPicked?: () => void;
  /** The pane above, which a handle on the divider trades height with when the section is expanded. */
  resizeAgainst?: RefObject<HTMLElement | null>;
}) {
  const scratch = useChatScratch(projectId, threadId);
  const list = useEntryList({ projectId, areas: scratch.areas });
  const { source } = scratch;
  if (!source) return null;
  return (
    <DockedRailSection id="scratch" resizeAgainst={resizeAgainst}>
      {({ expanded, setExpanded }) => (
        <EntryList list={list}>
          <AreaDropRegion
            scheme="scratch"
            catalogRootId={scratch.primary.catalog?.root.entryId ?? null}
            reveal={() => !expanded && setExpanded(true)}
            className="flex min-h-0 flex-col"
            header={(dropProps) => (
              <RailPaneHeader
                label={schemeLabel("scratch")}
                icon={schemeIcon("scratch")}
                title={source.heading}
                ariaLabel={source.heading}
                expanded={expanded}
                onExpandedChange={setExpanded}
                dropProps={dropProps}
              />
            )}
          >
            {expanded ? (
              <div className="min-h-0 overflow-y-auto overflow-x-hidden pb-1">
                <TreeGroup depth={1}>
                  <ChatScratchTree
                    projectId={projectId}
                    scratch={scratch}
                    depth={1}
                    onPicked={onPicked}
                  />
                </TreeGroup>
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
        <TreeGroup depth={1}>
          <ChatScratchTree projectId={projectId} scratch={scratch} depth={1} onPicked={onPicked} />
        </TreeGroup>
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
  return <RailEmptyHint>{t`No scratch notes yet.`}</RailEmptyHint>;
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
  const deletion = useDeleteContextEntry(projectId);
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
          <RailFolderRow
            icon={earlierOpen ? FolderOpen : Folder}
            name={t`Earlier notes`}
            depth={depth}
            expanded={earlierOpen}
            onToggle={() => expansion.toggleEntry(EARLIER_NOTES_ID)}
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
          owner={source.owner}
          editable={editable}
          depth={depth}
          openId={openId}
          expansion={expansion}
          onPicked={onPicked}
          onRequestDelete={deletion.requestDelete}
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
  onRequestDelete: (target: DeleteTarget) => void;
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
