/**
 * RecentDocumentsLanding — the Editor pane's empty state.
 *
 * Replaces the old "New document / pick a file from the tree" dead end with the
 * documents the writer last opened in this project, so an empty editor answers
 * "where was I?" The list is scoped to the project it renders inside, so the
 * rows need no project label: path and time are what is left to disambiguate.
 *
 * Device-local history paints first. The network adds other devices and never
 * gates this writer's own openings. The top margin holds the notice for
 * documents that closed under the writer, so the list never moves for it.
 */
import { Trans } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { FilePlus } from "lucide-react";
import { useProject } from "@/client/query/useProjectList";
import { useRecentDocuments } from "@/client/query/useRecentDocuments";
import type { AccountRecentItem } from "@/client/recents";
import { readableRecentPath } from "@/client/recents";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { editorColumnChrome } from "@/features/editor/editor-column";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { cn } from "@/lib/utils";
import { RecencyGroupedList } from "../RecencyGroupedList";
import { RowIcon } from "../RuledList";
import { relativeTime } from "../relative-time";
import { useOpenContextRoute } from "../routing/ProjectNavigationContext";
import { projectAddressHref } from "../routing/project-address";
import { fileKindIcon } from "./context-file-icon";
import { useReferenceDrag } from "./entry-drag/reference-source";
import { useOpenProjectDocument } from "./open-project-document";
import { RemovedDocumentLandingNotice } from "./RemovedDocumentNotice";

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
        {holdsRemovedNotice ? (
          <RemovedDocumentLandingNotice
            projectId={projectId}
            className="absolute inset-x-6 top-4 justify-center"
          />
        ) : null}
        <LandingEmpty onNewDocument={onNewDocument} />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn(editorColumnChrome, "pb-24")}>
        <div className="flex h-16 items-center">
          {holdsRemovedNotice ? (
            <RemovedDocumentLandingNotice projectId={projectId} className="min-w-0" />
          ) : null}
        </div>
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-headline-section text-foreground">
              <Trans>Recently opened</Trans>
            </h2>
          </div>
          <Button
            size="sm"
            className="[@media(pointer:coarse)]:min-h-11"
            onClick={onNewDocument}
            disabled={!onNewDocument}
          >
            <FilePlus aria-hidden />
            <Trans>New document</Trans>
          </Button>
        </div>

        {loading ? (
          <LandingLoading />
        ) : (
          <>
            <div className="mt-7">
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
            </div>
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

const recentRowClass = "focus-ring flex w-full items-start gap-3.5 rounded-md py-2.5 text-left";

function RecentDocumentRow({
  item,
  now,
  projectId,
  onOpen,
}: {
  item: AccountRecentItem;
  now: number;
  projectId: string | undefined;
  onOpen: (item: AccountRecentItem) => void;
}) {
  const router = useRouter();
  const href = recentDocumentHref(item, projectId);
  const content = <RecentDocumentContent item={item} now={now} />;
  // By the document's identity, never the path it was opened at; a local document is no entry yet.
  const drag = useReferenceDrag(
    item.address.kind === "document"
      ? { ref: { kind: "file", id: item.documentId }, name: item.name }
      : null,
  );
  if (!href) {
    return (
      <button
        type="button"
        {...drag}
        onClick={() => onOpen(item)}
        className={cn(recentRowClass, "border-0 bg-transparent")}
      >
        {content}
      </button>
    );
  }
  return (
    <a
      href={href}
      {...drag}
      onClick={(event) => {
        // Plain left-click navigates in place; modified clicks keep their
        // native new-tab/window behavior.
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        ) {
          return;
        }
        event.preventDefault();
        void router.navigate({ href });
      }}
      className={recentRowClass}
    >
      {content}
    </a>
  );
}

function RecentDocumentContent({ item, now }: { item: AccountRecentItem; now: number }) {
  const age = relativeTime(item.openedAt, now);
  const parentPath =
    item.address.kind === "document" ? item.address.path.replace(/\/[^/]+$/, "") : "";
  return (
    <>
      <RowIcon icon={fileKindIcon(item.name)} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{item.name}</span>
        {parentPath ? (
          <span className="mt-0.5 flex items-baseline gap-2.5 text-xs">
            <span className="truncate text-muted-foreground">{parentPath}</span>
          </span>
        ) : null}
      </span>
      <span aria-hidden className="mt-0.5 shrink-0 text-xs tabular-nums text-ink-subtle">
        {age}
      </span>
    </>
  );
}

async function openRecent(
  item: AccountRecentItem,
  ports: {
    projectId: string;
    editorWorkId: string | null;
    openDocument: ReturnType<typeof useOpenProjectDocument>;
    openRoute: ReturnType<typeof useOpenContextRoute>;
  },
): Promise<void> {
  if (item.address.kind !== "local") {
    await ports.openDocument({
      documentId: item.documentId,
      workId: ports.editorWorkId ?? undefined,
    });
    return;
  }
  if (!ports.openRoute) return;
  await ports.openRoute(
    {
      scheme: "unfiled",
      path: "",
      workId: ports.editorWorkId ?? undefined,
      documentId: item.documentId,
    },
    {
      tab: {
        kind: "new",
        documentId: item.documentId,
        name: item.name,
        resourceHandle: item.address.resourceHandle,
      },
    },
  );
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

    work: { kind: "absent" },
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
      <Button
        size="sm"
        className="mt-5 [@media(pointer:coarse)]:min-h-11"
        onClick={onNewDocument}
        disabled={!onNewDocument}
      >
        <FilePlus aria-hidden />
        <Trans>New document</Trans>
      </Button>
    </>
  );
}
