/**
 * RecentDocumentsLanding — the Editor pane's empty state.
 *
 * Replaces the old "New document / pick a file from the tree" dead end with the
 * documents the writer last opened, so an empty editor answers "where was I?"
 * The list is account-global (across projects), so every row carries its
 * project name and path; a row in another project navigates there.
 *
 * Server-owned and cross-device; renders device-cached rows first and lets the
 * network improve them.
 */
import { Trans, useLingui } from "@lingui/react/macro";
import type { RecentDocumentItem } from "@meridian/contracts/protocol";
import { Link } from "@tanstack/react-router";
import { FilePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useRecentDocuments } from "@/client/query/useRecentDocuments";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { editorColumnChrome } from "@/features/editor/editor-column";
import { cn } from "@/lib/utils";
import { relativeTime } from "../relative-time";
import { fileKindIcon } from "./context-file-icon";

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
  if (opened >= startOfDay(today - 86_400_000)) return "yesterday";
  return "earlier";
}

function groupLabel(group: Group): string {
  switch (group) {
    case "today":
      return "Today";
    case "yesterday":
      return "Yesterday";
    default:
      return "Earlier";
  }
}

export function RecentDocumentsLanding({
  onNewDocument,
  onBrowseTree,
}: {
  /** Starts a local document in the current project (Unfiled). */
  onNewDocument?: () => void;
  /**
   * Reveals the project tree. Omitted when the rail is already open, so the
   * hint never offers a door to something the writer can already see.
   */
  onBrowseTree?: () => void;
}) {
  const { t } = useLingui();
  const recent = useRecentDocuments();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // No history: the heading promises a list that does not exist, so the
  // first-run state stands alone rather than sitting under it.
  if (recent.status === "empty") {
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
            <p className="mt-0.5 text-xs text-muted-foreground">
              <Trans>Across all your projects</Trans>
            </p>
          </div>
          <Button size="sm" onClick={onNewDocument} disabled={!onNewDocument}>
            <FilePlus aria-hidden />
            <Trans>New document</Trans>
          </Button>
        </div>

        {recent.status === "loading" ? (
          <LandingLoading />
        ) : recent.status === "error" ? (
          <div className="mt-2">
            <InlineErrorRow
              message={<Trans>Couldn't load recent documents.</Trans>}
              onRetry={recent.refetch}
            />
          </div>
        ) : (
          <div className="mt-7 flex flex-col">
            {GROUPS.map((group) => {
              const rows = (recent.documents ?? []).filter(
                (item) => groupFor(item.openedAt, now) === group,
              );
              if (rows.length === 0) return null;
              return (
                <section key={group} className="mt-7 first:mt-0">
                  <SectionLabel variant="group">{groupLabel(group)}</SectionLabel>
                  <ul className="mt-2 divide-y divide-border-subtle">
                    {rows.map((item) => (
                      <li key={item.documentId}>
                        <RecentDocumentRow item={item} now={now} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}

        <p className="mt-8 text-xs text-muted-foreground">
          <Trans>Documents you open show up here.</Trans>{" "}
          {onBrowseTree ? (
            <button type="button" onClick={onBrowseTree} className="text-button text-xs">
              {t`Browse the project tree`}
            </button>
          ) : (
            <Trans>Browse the project tree to open another.</Trans>
          )}
        </p>
      </div>
    </div>
  );
}

function RecentDocumentRow({ item, now }: { item: RecentDocumentItem; now: number }) {
  const Icon = fileKindIcon(item.name);
  const age = relativeTime(item.openedAt, now);
  // The readable project address is path-based: /p/{slug}/{scheme}/{path}.
  const splat = `${item.scheme}/${item.path.replace(/^\/+/, "")}`;
  return (
    <Link
      to="/p/$projectSlug/$"
      params={{ projectSlug: item.projectSlug, _splat: splat }}
      className="focus-ring flex items-start gap-3.5 rounded-md py-2.5"
    >
      <span className="mt-0.5 grid size-[18px] shrink-0 place-items-center text-ink-subtle">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{item.name}</span>
        <span className="mt-0.5 flex items-baseline gap-2.5 text-xs">
          <span className="shrink-0 text-ink-subtle">{item.projectName}</span>
          <span className="truncate text-muted-foreground">{item.path}</span>
        </span>
      </span>
      <span className="mt-0.5 shrink-0 text-xs tabular-nums text-ink-subtle">{age}</span>
    </Link>
  );
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
