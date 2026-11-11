/** Routed Trash popup: a desktop list and preview, or a phone list/detail flow. */

import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";
import { ArchiveRestore, ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { useDocumentTrash, useTrashedDocument } from "@/client/query/useDocumentTrash";
import { DocumentNotice } from "@/components/app/DocumentNotice";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { PhoneTakeover } from "@/components/ui/phone-shell";
import { role } from "@/components/ui/roles";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { cn } from "@/lib/utils";
import { daysUntilPurge } from "../deletion-retention";
import { relativeTime } from "../relative-time";
import {
  useCaptureProjectNavigation,
  useProjectTrashNavigation,
} from "../routing/ProjectNavigationContext";
import { RowIcon, rowPaddingLeft } from "./ContextTreeRows";
import { fileKindIcon } from "./context-file-icon";
import {
  contextTreeFileRowClassName,
  contextTreeOverflowTriggerClassName,
} from "./context-row-geometry";
import { schemeLabel } from "./context-schemes";
import { type TrashRestoreState, useDocumentTrashRestore } from "./DocumentTrashRestoreProvider";
import { trashDragEntry } from "./entry-drag/entry";
import { useEntryRow } from "./entry-drag/use-entry-row";
import { useOpenProjectDocument } from "./open-project-document";
import { type RemovalVoice, removalVoice } from "./RemovedDocumentNotice";
import type { TrashRestoreOutcome } from "./restore-trashed-document";
import { ReadOnlyViewerFrame } from "./viewers/ReadOnlyViewerFrame";
import { TextViewer } from "./viewers/TextViewer";

type TrashEntry = DocumentTrashEntry;
type AfterRestore = (
  outcome: Extract<TrashRestoreOutcome, { kind: "living" }>,
) => Promise<string | null>;

export function DocumentTrashDialog({ projectId }: { projectId: string }) {
  const { destination, navigate } = useProjectTrashNavigation();
  const { states, restore } = useDocumentTrashRestore();
  const isPhone = usePhoneShell();
  const query = useDocumentTrash(projectId);
  const entries = query.data?.documents ?? [];
  const selectedId = typeof destination === "string" ? destination : entries[0]?.documentId;
  useMissingSelectionReconciliation(
    destination,
    selectedId,
    entries,
    selectedId ? states.get(selectedId) : undefined,
    navigate,
  );

  return (
    <Dialog open={destination !== undefined} onOpenChange={(open) => !open && void navigate(false)}>
      {isPhone === null ? null : isPhone ? (
        <PhoneTrashContent
          projectId={projectId}
          destination={destination}
          selectedId={selectedId}
          entries={entries}
          query={query}
          states={states}
          onSelect={(documentId) => void navigate(documentId, { replace: true })}
          onBack={() => void navigate(true, { replace: true })}
          onRestore={restore}
        />
      ) : (
        <DialogContent className="@container/trash flex h-[min(48rem,calc(100%-2rem))] max-h-[calc(100%-2rem)] max-w-[min(64rem,calc(100%-2rem))] gap-0 overflow-hidden rounded-lg p-0">
          <TrashListPane
            entries={entries}
            query={query}
            selectedId={selectedId}
            states={states}
            onSelect={(documentId) => void navigate(documentId, { replace: true })}
            onRestore={(entry, afterRestore) => {
              void navigate(entry.documentId, { replace: true });
              restore(entry, afterRestore);
            }}
            showHeading
            className="w-72 shrink-0 border-r border-border-subtle bg-ink-fill pt-4"
          />
          <section className="min-h-0 min-w-0 flex-1 bg-background [&>section>header]:pr-12">
            {selectedId ? (
              <TrashedDocumentView
                key={selectedId}
                projectId={projectId}
                documentId={selectedId}
                state={states.get(selectedId)}
                onRestore={restore}
                showHeader
              />
            ) : query.isPending ? (
              <p role="status" className={cn("px-4", role.emptyLine)}>
                <Trans>Loading Trash…</Trans>
              </p>
            ) : null}
          </section>
        </DialogContent>
      )}
    </Dialog>
  );
}

type TrashQuery = ReturnType<typeof useDocumentTrash>;
type TrashNavigate = ReturnType<typeof useProjectTrashNavigation>["navigate"];

function useMissingSelectionReconciliation(
  destination: true | string | undefined,
  selectedId: string | undefined,
  entries: readonly TrashEntry[],
  state: TrashRestoreState | undefined,
  navigate: TrashNavigate,
) {
  const previous = useRef<{ id: string; index: number } | null>(null);
  const selectedIndex = selectedId
    ? entries.findIndex((entry) => entry.documentId === selectedId)
    : -1;
  if (typeof destination === "string" && selectedIndex >= 0) {
    previous.current = { id: destination, index: selectedIndex };
  }
  useEffect(() => {
    if (typeof destination !== "string" || selectedIndex >= 0 || state?.kind === "restoring")
      return;
    const removed = previous.current;
    if (!removed || removed.id !== destination) return;
    previous.current = null;
    const next = entries[Math.min(removed.index, entries.length - 1)];
    void navigate(next?.documentId ?? true, { replace: true });
  }, [destination, entries, navigate, selectedIndex, state?.kind]);
}

function PhoneTrashContent({
  projectId,
  destination,
  selectedId,
  entries,
  query,
  states,
  onSelect,
  onBack,
  onRestore,
}: {
  projectId: string;
  destination: true | string | undefined;
  selectedId: string | undefined;
  entries: readonly TrashEntry[];
  query: TrashQuery;
  states: ReadonlyMap<string, TrashRestoreState>;
  onSelect: (documentId: string) => void;
  onBack: () => void;
  onRestore: (entry: TrashEntry, afterRestore?: AfterRestore) => void;
}) {
  const detail = typeof destination === "string";
  return (
    <PhoneTakeover
      title={
        detail
          ? entries.find((entry) => entry.documentId === selectedId)?.name || t`Trash`
          : t`Trash`
      }
      description={
        detail ? <Trans>Read-only document in Trash.</Trans> : <Trans>Deleted documents.</Trans>
      }
      closeLabel={t`Close Trash`}
      leading={
        detail ? (
          <IconButton size="sm" label={t`Back to Trash`} onClick={onBack}>
            <ChevronLeft className="size-5" aria-hidden />
          </IconButton>
        ) : undefined
      }
    >
      <div className="min-h-0 flex-1">
        {detail && selectedId ? (
          <TrashedDocumentView
            key={selectedId}
            projectId={projectId}
            documentId={selectedId}
            state={states.get(selectedId)}
            onRestore={onRestore}
            showHeader={false}
          />
        ) : (
          <TrashListPane
            entries={entries}
            query={query}
            selectedId={undefined}
            states={states}
            onSelect={onSelect}
            onRestore={onRestore}
            className="h-full overflow-y-auto overscroll-contain py-2"
          />
        )}
      </div>
    </PhoneTakeover>
  );
}

function TrashListPane({
  entries,
  query,
  selectedId,
  states,
  onSelect,
  onRestore,
  className,
  showHeading = false,
}: {
  entries: readonly TrashEntry[];
  query: TrashQuery;
  selectedId: string | undefined;
  states: ReadonlyMap<string, TrashRestoreState>;
  onSelect: (documentId: string) => void;
  onRestore: (entry: TrashEntry, afterRestore?: AfterRestore) => void;
  className?: string;
  showHeading?: boolean;
}) {
  const now = useMinuteClock();
  return (
    <aside className={cn("min-h-0 overflow-y-auto", className)}>
      {showHeading ? (
        <div className="px-5 pb-3">
          <DialogTitle>
            <Trans>Trash</Trans>
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>Deleted documents.</Trans>
          </DialogDescription>
        </div>
      ) : null}
      {query.isError ? (
        <div className="px-4 py-2">
          <InlineErrorRow message={t`Couldn't load Trash.`} onRetry={() => void query.refetch()} />
        </div>
      ) : entries.length ? (
        <div className="pb-2">
          {entries.map((entry) => (
            <TrashRow
              key={entry.documentId}
              entry={entry}
              now={now}
              selected={entry.documentId === selectedId}
              state={states.get(entry.documentId)}
              onOpen={() => onSelect(entry.documentId)}
              onRestore={() => {
                onRestore(entry);
              }}
            />
          ))}
        </div>
      ) : query.isPending ? (
        <p role="status" className={cn("px-4", role.emptyLine)}>
          <Trans>Loading Trash…</Trans>
        </p>
      ) : (
        <p className={cn("px-4", role.emptyLine)}>
          <Trans>Nothing in the trash.</Trans>
        </p>
      )}
    </aside>
  );
}

/** One deleted document: its name, age and former place, with Restore. Drags like a tree row inside a list. */
export function TrashRow({
  entry,
  now,
  selected,
  state,
  onOpen,
  onRestore,
}: {
  entry: TrashEntry;
  now: number;
  selected: boolean;
  state?: TrashRestoreState;
  onOpen: () => void;
  onRestore: () => void;
}) {
  const location = `${schemeLabel(entry.scheme)}/${entry.formerPath}`;
  const age = relativeTime(entry.removal.time, now);
  const restoring = state?.kind === "restoring";
  // Inside a tree's selection scope the row selects and drags like a tree row, to be restored where it lands.
  const row = useEntryRow(trashDragEntry(entry), selected, !restoring, "trash");
  return (
    <div>
      {/* biome-ignore lint/a11y/useSemanticElements: row nests a separate kebab button. slop-lint: allow suppression the reason is stated in this comment */}
      <div
        role="button"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        {...row.rowProps}
        onClick={row.activate(onOpen)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          row.activate(onOpen)(event);
        }}
        className={cn(contextTreeFileRowClassName(selected), "focus-ring py-1.5")}
        style={{ paddingLeft: rowPaddingLeft(0) }}
      >
        <RowIcon icon={fileKindIcon(entry.name)} />
        <span className="ml-0.5 min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <span className={cn("shrink-0 font-normal tabular-nums", role.rowSecondary)}>
              {restoring ? <Trans>Restoring</Trans> : age}
            </span>
          </span>
          <span
            className={cn("block truncate leading-snug font-normal", role.rowSecondary)}
            title={location}
          >
            {location}
          </span>
        </span>
        <OverflowMenu
          label={t`Actions`}
          triggerClassName={contextTreeOverflowTriggerClassName}
          triggerProps={{ disabled: restoring }}
        >
          <DropdownMenuItem onSelect={onRestore}>
            <ArchiveRestore className="size-3.5 text-muted-foreground" aria-hidden />
            <Trans>Restore</Trans>
          </DropdownMenuItem>
        </OverflowMenu>
      </div>
      {state?.kind === "failed" ? (
        <InlineErrorRow message={state.message} className="pt-0 pr-2 pb-1 pl-3.5" />
      ) : null}
    </div>
  );
}

function TrashedDocumentView({
  projectId,
  documentId,
  state,
  onRestore,
  showHeader,
}: {
  projectId: string;
  documentId: string;
  state?: TrashRestoreState;
  onRestore: (entry: TrashEntry, afterRestore?: AfterRestore) => void;
  showHeader: boolean;
}) {
  const { i18n } = useLingui();
  const query = useTrashedDocument(projectId, documentId);
  const openDocument = useOpenProjectDocument(projectId);
  const captureNavigation = useCaptureProjectNavigation();
  const document = query.data;

  const restore = useCallback(() => {
    if (!document || state?.kind === "restoring") return;
    const isCurrent = captureNavigation?.() ?? (() => true);
    onRestore(document, async () => {
      if (!isCurrent()) return null;
      const opened = await openDocument({
        documentId,
        disposition: "current",
        refreshIdentity: true,
      });
      return opened.kind === "committed"
        ? null
        : t`Restored ${document.name}, but couldn't open it. Try again from the file list.`;
    });
  }, [captureNavigation, document, documentId, onRestore, openDocument, state?.kind]);

  if (query.isError) {
    return (
      <div className="p-4">
        {[404, 410].includes(httpErrorStatus(query.error) ?? 0) ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No longer available</Trans>
          </p>
        ) : (
          <InlineErrorRow
            message={t`Couldn't load this document.`}
            onRetry={() => void query.refetch()}
          />
        )}
      </div>
    );
  }
  if (query.isPending || !document) {
    return (
      <p role="status" className={cn("px-4", role.emptyLine)}>
        <Trans>Loading document…</Trans>
      </p>
    );
  }
  return (
    <ReadOnlyViewerFrame
      header={
        showHeader
          ? { name: document.name, path: `${schemeLabel(document.scheme)}/${document.formerPath}` }
          : undefined
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <TrashNotice entry={document} locale={i18n.locale} state={state} onRestore={restore} />
        <div className="min-h-0 flex-1">
          <TextViewer source={{ content: document.markdown }} name={document.name} markdown />
        </div>
      </div>
    </ReadOnlyViewerFrame>
  );
}

function TrashNotice({
  entry,
  locale,
  state,
  onRestore,
}: {
  entry: TrashEntry;
  locale: string;
  state?: TrashRestoreState;
  onRestore: () => void;
}) {
  const actor = removalActor(entry);
  const deleted = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
    new Date(entry.removal.time),
  );
  const retention = retentionSentence(entry, locale);
  return (
    <div className="shrink-0 px-4 pt-3">
      <DocumentNotice
        icon={<ArchiveRestore className="size-4" aria-hidden />}
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={state?.kind === "restoring"}
            onClick={onRestore}
          >
            {state?.kind === "restoring" ? <Trans>Restoring</Trans> : <Trans>Restore</Trans>}
          </Button>
        }
      >
        <Trans>
          In the trash. Deleted by {actor} on {deleted}.
        </Trans>{" "}
        {retention}
      </DocumentNotice>
      {state?.kind === "failed" ? (
        <InlineErrorRow message={state.message} className="px-0 pt-2 pb-0" />
      ) : null}
    </div>
  );
}

function retentionSentence(entry: TrashEntry, locale: string): string {
  if (entry.retention.kind === "held") {
    const works = new Intl.ListFormat(locale, { type: "conjunction" }).format(
      entry.retention.works.map(({ name }) => name),
    );
    return entry.retention.works.length === 1
      ? t`Kept while ${works} has changes to it.`
      : t`Kept while ${works} have changes to it.`;
  }
  const days = daysUntilPurge(entry.retention.purgeAt, Date.now());
  return plural(days, {
    one: "Gone for good in # day.",
    other: "Gone for good in # days.",
  });
}

function removalActor(entry: TrashEntry): string {
  const voice: RemovalVoice = removalVoice({
    reason: "deleted",
    actor: entry.actor,
    time: entry.removal.time,
  });
  switch (voice.kind) {
    case "person":
      return voice.name;
    case "agent":
      return voice.chat ? t`AI in ${voice.chat}` : t`AI in a chat`;
    case "work":
      return voice.name;
    case "unfinished-reply":
      return t`the system`;
    case "anonymous":
      return t`a writer`;
  }
}
