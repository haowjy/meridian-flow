/**
 * RecentDocumentsLanding — the Editor pane's empty state.
 *
 * Replaces the old "New document / pick a file from the tree" dead end with the
 * documents the writer last opened in this project, so an empty editor answers
 * "where was I?" The list is scoped to the project it renders inside, so the
 * rows need no project label: path and time are what is left to disambiguate.
 *
 * Device-local history paints first. The network adds other devices and never
 * gates this writer's own openings. The top margin holds the notice of a
 * Discard that sent main here, then the notice for documents that closed under
 * the writer, so the list never moves for them.
 */

import { Trans } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { FilePlus } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useProject } from "@/client/query/useProjectList";
import { useRecentDocuments } from "@/client/query/useRecentDocuments";
import type { AccountRecentItem } from "@/client/recents";
import { readableRecentPath } from "@/client/recents";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { ListRow } from "@/components/ui/list-row";
import { role } from "@/components/ui/roles";
import { Skeleton } from "@/components/ui/skeleton";
import { DraftNoticeLine, useDocumentNotice } from "@/features/draft-review/CommandNotice";
import { editorColumnChrome } from "@/features/editor/editor-column";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { cn } from "@/lib/utils";
import { RecencyGroupedList } from "../RecencyGroupedList";
import { relativeTime } from "../relative-time";
import { useOpenContextRoute } from "../routing/ProjectNavigationContext";
import { projectAddressHref } from "../routing/project-address";
import {
  ContextEntryMenu,
  type EntryAction,
  EntryKebabButton,
  useEntryMenu,
} from "./ContextEntryActions";
import { fileKindIcon } from "./context-file-icon";
import { documentPlace } from "./context-schemes";
import { EntryDestinationPicker } from "./EntryDestinationPicker";
import { type DragEntry, LIVE_VIEW } from "./entry-drag/entry";
import { EntrySelectionProvider, useEntrySelection } from "./entry-drag/selection";
import { useEntryRow } from "./entry-drag/use-entry-row";
import { useOpenProjectDocument } from "./open-project-document";
import { RemovedDocumentLandingNotice } from "./RemovedDocumentNotice";
import { useDeleteContextEntries } from "./use-delete-context-entries";

export function RecentDocumentsLanding({
  projectId,
  editorWorkId = null,
  onNewDocument,
  holdsRemovedNotice = false,
}: {
  projectId: string;
  editorWorkId?: string | null;
  /** No tab is left to hold the removed-documents notice in the strip. */
  holdsRemovedNotice?: boolean;
  /** Starts a local document in the current project (Unfiled). */
  onNewDocument?: () => void;
}) {
  const recent = useRecentDocuments(projectId);
  const project = useProject(projectId);
  const openDocument = useOpenProjectDocument(projectId);
  const openRoute = useOpenContextRoute();
  const now = useMinuteClock();
  const deleteEntries = useDeleteContextEntries(projectId);
  // Its Undo must stay reachable, so it shows here on the phone too, ahead of the removal's.
  const discarded = useDocumentNotice(projectId, null);
  const discardNotice = discarded ? <DraftNoticeLine notice={discarded} className="px-0" /> : null;

  const documents = recent.documents ?? [];
  // A cached empty list with a refetch in flight is not yet known to be empty.
  // Showing "Nothing opened yet" here is the lie B1 was about.
  const settling = recent.status === "empty" && recent.isFetching;
  const loading = recent.status === "loading" || settling;

  // No history: the heading promises a list that does not exist, so the
  // first-run state stands alone rather than sitting under it.
  if (recent.status === "empty" && !settling) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 text-center">
        <div className="absolute inset-x-6 top-4 flex flex-col items-center">
          {discardNotice}
          {holdsRemovedNotice ? (
            <RemovedDocumentLandingNotice projectId={projectId} className="justify-center" />
          ) : null}
        </div>
        <LandingEmpty onNewDocument={onNewDocument} />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn(editorColumnChrome, "pb-24")}>
        <div className="flex h-16 flex-col justify-center">
          {discardNotice}
          {holdsRemovedNotice ? (
            <RemovedDocumentLandingNotice projectId={projectId} className="min-w-0" />
          ) : null}
        </div>
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className={role.sectionHeading}>
              <Trans>Recently opened</Trans>
            </h2>
          </div>
          <Button size="sm" onClick={onNewDocument} disabled={!onNewDocument}>
            <FilePlus aria-hidden />
            <Trans>New document</Trans>
          </Button>
        </div>

        {loading ? (
          <LandingLoading />
        ) : (
          <>
            <RecentSelection>
              <RecencyGroupedList
                items={documents}
                now={now}
                timestamp={(item) => item.openedAt}
                itemKey={(item) => item.documentId}
                renderItem={(item) => (
                  <RecentDocumentRow
                    item={item}
                    now={now}
                    projectId={project?.id}
                    onDelete={deleteEntries}
                    onOpen={(item) => {
                      void openRecent(item, {
                        projectId,
                        editorWorkId,
                        openDocument,
                        openRoute,
                      });
                    }}
                  />
                )}
              />
            </RecentSelection>
            {/* A failed refresh over cached rows keeps the list and offers a
                quiet retry; a failed first load has nothing to show. */}
            {recent.isError ? (
              documents.length > 0 ? (
                <p className="mt-5 text-xs text-muted-foreground">
                  <Trans>Couldn't refresh recent documents.</Trans>{" "}
                  <button type="button" onClick={recent.refetch} className="text-button text-xs">
                    <Trans>Retry</Trans>
                  </button>
                </p>
              ) : (
                <div className="mt-2">
                  <InlineErrorRow
                    message={<Trans>Couldn't load recent documents.</Trans>}
                    onRetry={recent.refetch}
                  />
                </div>
              )
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** The list's own selection: rows select as in the sidebar, and its menu acts on all of them. */
function RecentSelection({ children }: { children: ReactNode }) {
  const selection = useEntrySelection();
  return (
    <div className="mt-7">
      <EntrySelectionProvider selection={selection}>{children}</EntrySelectionProvider>
    </div>
  );
}

function RecentDocumentRow({
  item,
  now,
  projectId,
  onOpen,
  onDelete,
}: {
  item: AccountRecentItem;
  now: number;
  projectId: string | undefined;
  onOpen: (item: AccountRecentItem) => void;
  onDelete: (entries: readonly DragEntry[]) => void;
}) {
  const router = useRouter();
  const href = recentDocumentHref(item, projectId);
  const address = item.address.kind === "document" ? item.address : null;
  const entry = useMemo<DragEntry>(
    () => ({ ref: { kind: "file", id: item.documentId }, name: item.name, view: LIVE_VIEW }),
    [item.documentId, item.name],
  );
  // A drag carries the selection by identity, never the path it was opened at, and asks Move or
  // Copy as any reference does. A local document is no entry yet.
  const row = useEntryRow(entry, {
    active: false,
    draggable: address !== null,
    source: "reference",
  });
  // A filed document moves and deletes from here; an Untitled one, or a note in a chat's
  // Scratch (whose owner the list doesn't know), grants nothing.
  const actions = address && address.scheme !== "scratch" ? MOVE_DELETE : NONE;
  const [moving, setMoving] = useState<readonly DragEntry[] | null>(null);
  const menu = useEntryMenu(entry, actions, (action, selection) => {
    if (action === "delete") onDelete(selection ?? [entry]);
    else if (action === "move") setMoving(selection ?? [entry]);
  });
  const { "aria-pressed": _pressed, ...selectionProps } = row.rowProps;
  const listRow = (
    <ListRow
      href={href ?? undefined}
      onOpen={() => (href ? void router.navigate({ href }) : onOpen(item))}
      selected={row.selected}
      controlProps={{
        ...selectionProps,
        // Ctrl/Cmd- and Shift-click select here, as in the sidebar, before the link sees them.
        onClickCapture: (event) => {
          if (!row.select(event)) return;
          event.preventDefault();
          event.stopPropagation();
        },
      }}
      wrapControl={(control) => <ContextEntryMenu menu={menu}>{control}</ContextEntryMenu>}
      icon={fileKindIcon(item.name)}
      title={item.name}
      detail={address ? documentPlace(address.scheme, address.path) : null}
      // The age is for the eye; the row's name is the document and where it lives.
      meta={<span aria-hidden>{relativeTime(item.openedAt, now)}</span>}
      actions={<EntryKebabButton menu={menu} className="opacity-100" />}
      revealActions
    />
  );
  return (
    // The row's inset hangs outside the column, so names stay on the heading's edge.
    <div className="-mx-1.5">
      {address && projectId ? (
        <EntryDestinationPicker
          projectId={projectId}
          action="move"
          from={{ scheme: address.scheme, owner: {} }}
          entry={{ id: item.documentId, name: item.name, path: address.path, kind: "file" }}
          selection={moving ?? undefined}
          open={moving !== null}
          onOpenChange={(open) => !open && setMoving(null)}
        >
          {listRow}
        </EntryDestinationPicker>
      ) : (
        listRow
      )}
    </div>
  );
}

const MOVE_DELETE: readonly EntryAction[] = ["move", "delete"];
const NONE: readonly EntryAction[] = [];

/** Opens a Recently opened row in main; false when it did not land. */
export async function openRecent(
  item: AccountRecentItem,
  ports: {
    projectId: string;
    editorWorkId: string | null;
    openDocument: ReturnType<typeof useOpenProjectDocument>;
    openRoute: ReturnType<typeof useOpenContextRoute>;
  },
  replace?: true,
): Promise<boolean> {
  if (item.address.kind !== "local") {
    const outcome = await ports.openDocument({
      documentId: item.documentId,
      workId: ports.editorWorkId ?? undefined,
      ...(replace ? { replace } : {}),
    });
    return outcome.kind === "committed";
  }
  if (!ports.openRoute) return false;
  const settlement = await ports.openRoute(
    {
      scheme: "unfiled",
      path: "",
      documentId: item.documentId,
    },
    {
      ...(replace ? { replace } : {}),
      document: {
        kind: "new",
        documentId: item.documentId,
        name: item.name,
        resourceHandle: item.address.resourceHandle,
      },
    },
  );
  return settlement.kind === "applied";
}

function recentDocumentHref(item: AccountRecentItem, projectId: string | undefined): string | null {
  if (!projectId || item.address.kind !== "document") return null;
  const path = readableRecentPath(item.address.path);
  if (!path) return null;
  return projectAddressHref({
    projectId,
    destination: {
      kind: "document",
      scheme: item.address.scheme,
      path,
    },
  });
}

function LandingLoading() {
  return (
    <div className="mt-7 flex flex-col gap-2" role="status" aria-busy="true">
      <span className="sr-only">
        <Trans>Loading recent documents</Trans>
      </span>
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-11 w-full motion-reduce:animate-none" />
      ))}
    </div>
  );
}

function LandingEmpty({ onNewDocument }: { onNewDocument?: () => void }) {
  return (
    <>
      <p className="font-medium text-foreground">
        <Trans>Nothing opened yet</Trans>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        <Trans>Open a document from the project tree, or start a new one.</Trans>
      </p>
      <Button size="sm" className="mt-5" onClick={onNewDocument} disabled={!onNewDocument}>
        <FilePlus aria-hidden />
        <Trans>New document</Trans>
      </Button>
    </>
  );
}
