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
import { LIVE_VERSION } from "@/core/project-tree/tree-version";
import { twinSuffix } from "@/core/project-tree/tree-view";
import { DraftNoticeLine, useDocumentNotice } from "@/features/draft-review/CommandNotice";
import { editorColumnChrome } from "@/features/editor/editor-column";
import { focusMain } from "@/features/editor/focus-on-open";
import { MainSurface } from "@/features/editor/MainSurface";
import { useClock } from "@/hooks/use-clock";
import { cn } from "@/lib/utils";
import { RecencyGroupedList } from "../RecencyGroupedList";
import { relativeTime } from "../relative-time";
import { projectAddressHref } from "../routing/project-address";
import { type EntryAction, useEntryMenu } from "./ContextEntryActions";
import { fileKindIcon } from "./context-file-icon";
import { documentPlace } from "./context-schemes";
import { EntryDestinationPicker } from "./EntryDestinationPicker";
import { type DragEntry, LIVE_VIEW } from "./entry-drag/entry";
import { EntrySelectionProvider, useEntrySelection } from "./entry-drag/selection";
import { useEntryRow } from "./entry-drag/use-entry-row";
import { useOpenProjectDocument } from "./open-project-document";
import { useDeleteContextEntries } from "./use-delete-context-entries";

type RecentDocumentsLandingProps = {
  projectId: string;
  editorWorkId?: string | null;
  onNewDocument?: () => void;
};

export function RecentDocumentsLanding({
  projectId,
  editorWorkId = null,
  onNewDocument,
}: RecentDocumentsLandingProps) {
  const recent = useRecentDocuments(projectId);
  const project = useProject(projectId);
  const openDocument = useOpenProjectDocument(projectId);
  const now = useClock(60_000);
  const deleteEntries = useDeleteContextEntries(projectId, "main", LIVE_VERSION);
  const discarded = useDocumentNotice(projectId, null);
  const discardNotice = discarded ? <DraftNoticeLine notice={discarded} className="px-0" /> : null;

  const documents = recent.documents ?? [];
  const settling = recent.status === "empty" && recent.isFetching;
  const loading = recent.status === "loading" || settling;

  if (recent.status === "empty" && !settling) {
    return (
      <MainSurface
        joined
        className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 text-center"
      >
        <div className="absolute inset-x-6 top-4 flex flex-col items-center">{discardNotice}</div>
        <LandingEmpty onNewDocument={onNewDocument} />
      </MainSurface>
    );
  }

  return (
    <MainSurface joined={!loading} className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn(editorColumnChrome, "pb-24")}>
        <div className="flex h-16 flex-col justify-center">{discardNotice}</div>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <h2 className={role.sectionHeading}>
            <Trans>Recently opened</Trans>
          </h2>
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
                      });
                    }}
                  />
                )}
              />
            </RecentSelection>
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
    </MainSurface>
  );
}

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
  const row = useEntryRow(entry, {
    active: false,
    draggable: address !== null,
    source: "reference",
  });
  const actions = address && address.scheme !== "scratch" ? MOVE_DELETE : NONE;
  const [picking, setPicking] = useState<{
    action: "move" | "copy";
    rows: readonly DragEntry[];
  } | null>(null);
  const menu = useEntryMenu(
    entry,
    actions,
    (action, selection) => {
      if (action === "delete") onDelete(selection ?? [entry]);
      else if (action === "move" || action === "copy")
        setPicking({ action, rows: selection ?? [entry] });
    },
    address?.scheme === "user" ? "account" : "project",
  );
  // A link can't be pressed; `ListRow` names a selected link instead.
  const { "aria-pressed": _pressed, ...selectionProps } = row.rowProps;
  const listRow = (
    <ListRow
      href={href ?? undefined}
      onOpen={() => {
        focusMain();
        if (href) void router.navigate({ href });
        else onOpen(item);
      }}
      selected={row.selected}
      controlProps={selectionProps}
      menu={menu}
      icon={fileKindIcon(item.name)}
      title={item.name}
      suffix={address ? twinSuffix(address.path) : undefined}
      detail={address ? documentPlace(address.scheme, address.path) : null}
      meta={<span aria-hidden>{relativeTime(item.openedAt, now)}</span>}
      revealActions
    />
  );
  return (
    <div className="-mx-1.5">
      {address && projectId ? (
        <EntryDestinationPicker
          projectId={projectId}
          action={picking?.action ?? "move"}
          from={{ scheme: address.scheme, owner: {} }}
          entry={{ id: item.documentId, name: item.name, path: address.path, kind: "file" }}
          selection={picking?.rows}
          open={picking !== null}
          onOpenChange={(open) => !open && setPicking(null)}
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

export async function openRecent(
  item: AccountRecentItem,
  ports: {
    projectId: string;
    editorWorkId: string | null;
    openDocument: ReturnType<typeof useOpenProjectDocument>;
  },
  leaving?: true,
): Promise<boolean> {
  const outcome = await ports.openDocument({
    documentId: item.documentId,
    workId: ports.editorWorkId ?? undefined,
    ...(leaving ? { replace: true, fallsBack: true } : {}),
  });
  return outcome.kind === "committed";
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
        <Trans>Open a document or start a new one</Trans>
      </p>
      <Button size="sm" className="mt-5" onClick={onNewDocument} disabled={!onNewDocument}>
        <FilePlus aria-hidden />
        <Trans>New document</Trans>
      </Button>
    </>
  );
}
