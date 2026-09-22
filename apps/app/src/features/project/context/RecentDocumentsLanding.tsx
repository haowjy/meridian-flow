/**
 * RecentDocumentsLanding — the Editor pane's empty state.
 *
 * Replaces the old "New document / pick a file from the tree" dead end with the
 * documents the writer last opened in this project, so an empty editor answers
 * "where was I?" The list is scoped to the project it renders inside, so the
 * rows need no project label: path and time are what is left to disambiguate.
 *
 * Device-local history paints first. The network adds other devices and never
 * gates this writer's own openings.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { FilePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useProject } from "@/client/query/useProjectList";
import { useRecentDocuments } from "@/client/query/useRecentDocuments";
import type { AccountRecentItem } from "@/client/recents";
import { readableRecentPath } from "@/client/recents";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { editorColumnChrome } from "@/features/editor/editor-column";
import { cn } from "@/lib/utils";
import { relativeTime } from "../relative-time";
import { useOpenContextRoute } from "../routing/ProjectNavigationContext";
import { projectAddressHref } from "../routing/project-address";
import { useOptionalAccountResourceReplica } from "./account-feature-context";
import { fileKindIcon } from "./context-file-icon";
import { useOpenProjectDocument } from "./open-project-document";

/** Age buckets the list groups under, oldest last. */
const GROUPS = ["today", "yesterday", "earlier"] as const;
type Group = (typeof GROUPS)[number];

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function groupFor(openedAt: string, nowMs: number): Group {
  const opened = Date.parse(openedAt);
  if (Number.isNaN(opened)) return "earlier";
  const today = startOfDay(nowMs);
  if (opened >= today) return "today";
  // Day arithmetic, not a fixed 86400000: a DST day is not 24 hours long.
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return opened >= yesterday.getTime() ? "yesterday" : "earlier";
}

function groupLabel(group: Group): string {
  switch (group) {
    case "today":
      return t`Today`;
    case "yesterday":
      return t`Yesterday`;
    default:
      return t`Earlier`;
  }
}

export function RecentDocumentsLanding({
  projectId,
  editorWorkId = null,
  onNewDocument,
}: {
  projectId: string;
  editorWorkId?: string | null;
  /** Starts a local document in the current project (Unfiled). */
  onNewDocument?: () => void;
}) {
  const recent = useRecentDocuments(projectId);
  const project = useProject(projectId);
  const openDocument = useOpenProjectDocument(projectId);
  const openRoute = useOpenContextRoute();
  const resources = useOptionalAccountResourceReplica();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const documents = recent.documents ?? [];
  // A cached empty list with a refetch in flight is not yet known to be empty.
  // Showing "Nothing opened yet" here is the lie B1 was about.
  const settling = recent.status === "empty" && recent.isFetching;
  const loading = recent.status === "loading" || settling;

  // No history: the heading promises a list that does not exist, so the
  // first-run state stands alone rather than sitting under it.
  if (recent.status === "empty" && !settling) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 text-center">
        <LandingEmpty onNewDocument={onNewDocument} />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn(editorColumnChrome, "pt-16 pb-24")}>
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-headline-section text-foreground">
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
            <div className="mt-7 flex flex-col">
              {GROUPS.map((group) => {
                const rows = documents.filter((item) => groupFor(item.openedAt, now) === group);
                if (rows.length === 0) return null;
                return (
                  <section key={group} className="mt-7 first:mt-0">
                    <SectionLabel variant="group">{groupLabel(group)}</SectionLabel>
                    <ul className="mt-2 divide-y divide-border-subtle">
                      {rows.map((item) => (
                        <li key={item.documentId}>
                          <RecentDocumentRow
                            item={item}
                            now={now}
                            projectSlug={project?.slug}
                            onOpen={(item) => {
                              void openRecent(item, {
                                projectId,
                                editorWorkId,
                                openDocument,
                                openRoute,
                                resources,
                              });
                            }}
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
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
  projectSlug,
  onOpen,
}: {
  item: AccountRecentItem;
  now: number;
  projectSlug: string | undefined;
  onOpen: (item: AccountRecentItem) => void;
}) {
  const router = useRouter();
  const href = recentDocumentHref(item, projectSlug);
  const content = <RecentDocumentContent item={item} now={now} />;
  if (!href) {
    return (
      <button
        type="button"
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
  const Icon = fileKindIcon(item.name);
  const age = relativeTime(item.openedAt, now);
  const parentPath =
    item.address.kind === "document" ? item.address.path.replace(/\/[^/]+$/, "") : "";
  return (
    <>
      <span className="mt-0.5 grid size-[18px] shrink-0 place-items-center text-ink-subtle">
        <Icon className="size-4" aria-hidden />
      </span>
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
    resources: ReturnType<typeof useOptionalAccountResourceReplica>;
  },
): Promise<void> {
  if (item.address.kind !== "local") {
    await ports.openDocument({ documentId: item.documentId, workId: ports.editorWorkId });
    return;
  }
  if (!ports.openRoute) return;
  const opened = ports.resources
    ? await ports.resources.openKnownDocument(
        ports.projectId,
        item.documentId,
        `recents:${crypto.randomUUID()}`,
      )
    : { kind: "missing" as const };
  if (opened.kind !== "opened") return;
  try {
    await ports.openRoute(
      {
        scheme: "unfiled",
        path: "",
        workId: ports.editorWorkId,
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
  } finally {
    opened.handle.release();
  }
}

function recentDocumentHref(
  item: AccountRecentItem,
  projectSlug: string | undefined,
): string | null {
  if (!projectSlug || item.address.kind !== "document") return null;
  const path = readableRecentPath(item.address.path);
  if (!path) return null;
  return projectAddressHref({
    projectSlug,
    destination: {
      kind: "document",
      scheme: item.address.scheme,
      path,
      workSlug: null,
    },
    chat: { kind: "absent" },
    work: { kind: "absent" },
    results: false,
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
