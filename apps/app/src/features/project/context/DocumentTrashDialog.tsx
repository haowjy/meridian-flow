/** Routed Trash popup: a desktop list and preview, or a phone list/detail flow. */
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";
import { ArchiveRestore, ChevronLeft, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useCallback, useEffect, useRef } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { useDocumentTrash, useTrashedDocument } from "@/client/query/useDocumentTrash";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { useMinuteClock } from "@/hooks/use-minute-clock";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { cn } from "@/lib/utils";
import { daysUntilPurge } from "../deletion-retention";
import { relativeTime } from "../relative-time";
import {
  useCaptureProjectNavigation,
  useProjectTrashNavigation,
} from "../routing/ProjectNavigationContext";
import { RowIcon } from "./ContextTreeRows";
import { fileKindIcon } from "./context-file-icon";
import {
  contextTreeFileRowClassName,
  contextTreeOverflowTriggerClassName,
} from "./context-row-geometry";
import { schemeLabel } from "./context-schemes";
import { type TrashRestoreState, useDocumentTrashRestore } from "./DocumentTrashRestoreProvider";
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
            onRestore={restore}
            showHeading
            className="w-72 shrink-0 border-r border-border-subtle bg-muted pt-4"
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
              <p role="status" className="p-4 text-sm text-muted-foreground">
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
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.target as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        className="fixed inset-0 z-50 flex flex-col bg-background outline-none duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
      >
        <header
          className="shrink-0 border-b border-border-subtle bg-background"
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <div
            className="flex h-12 items-center gap-1"
            style={{
              paddingLeft: "calc(0.5rem + env(safe-area-inset-left))",
              paddingRight: "calc(0.5rem + env(safe-area-inset-right))",
            }}
          >
            {detail ? (
              <PhoneIconButton aria-label={t`Back to Trash`} onClick={onBack}>
                <ChevronLeft className="size-5" aria-hidden />
              </PhoneIconButton>
            ) : (
              <span className="size-11 shrink-0" aria-hidden />
            )}
            <DialogTitle className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-foreground">
              {detail
                ? entries.find((entry) => entry.documentId === selectedId)?.name || t`Trash`
                : t`Trash`}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {detail ? (
                <Trans>Read-only document in Trash.</Trans>
              ) : (
                <Trans>Deleted documents.</Trans>
              )}
            </DialogDescription>
            <DialogClose asChild>
              <PhoneIconButton aria-label={t`Close Trash`}>
                <X className="size-5" aria-hidden />
              </PhoneIconButton>
            </DialogClose>
          </div>
        </header>
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
      </DialogPrimitive.Content>
    </DialogPortal>
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
  const { navigate } = useProjectTrashNavigation();
  return (
    <aside className={cn("min-h-0 overflow-y-auto", className)}>
      {showHeading ? (
        <div className="px-5 pb-3">
          <DialogTitle className="text-lg font-semibold tracking-tight">
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
                void navigate(entry.documentId, { replace: true });
                onRestore(entry);
              }}
            />
          ))}
        </div>
      ) : query.isPending ? (
        <p role="status" className="px-5 py-3 text-sm text-muted-foreground">
          <Trans>Loading Trash…</Trans>
        </p>
      ) : (
        <p className="px-5 py-3 text-sm text-muted-foreground">
          <Trans>Nothing in the trash.</Trans>
        </p>
      )}
    </aside>
  );
}

function TrashRow({
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
  return (
    <div>
      {/* biome-ignore lint/a11y/useSemanticElements: row nests a separate kebab button. */}
      <div
        role="button"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen();
        }}
        className={cn(contextTreeFileRowClassName(selected), "py-1.5 pl-2")}
      >
        <RowIcon icon={fileKindIcon(entry.name)} />
        <span className="ml-0.5 min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
              {restoring ? <Trans>Restoring</Trans> : age}
            </span>
          </span>
          <span
            className="block truncate text-xs leading-snug font-normal text-ink-subtle"
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
        <p role="alert" className="px-5 pb-1 text-xs text-destructive">
          {state.message}
        </p>
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
      <p role="status" className="p-4 text-sm text-muted-foreground">
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
      <div
        role="status"
        className="flex min-w-0 items-center gap-3 rounded-lg border border-border-subtle bg-card py-1.5 pr-1.5 pl-3 text-sm"
      >
        <ArchiveRestore className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 text-muted-foreground">
          <Trans>
            In the trash. Deleted by {actor} on {deleted}.
          </Trans>{" "}
          {retention}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={state?.kind === "restoring"}
          onClick={onRestore}
          className="shrink-0 [@media(pointer:coarse)]:min-h-11"
        >
          {state?.kind === "restoring" ? <Trans>Restoring</Trans> : <Trans>Restore</Trans>}
        </Button>
      </div>
      {state?.kind === "failed" ? (
        <p role="alert" className="pt-2 text-xs text-destructive">
          {state.message}
        </p>
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
