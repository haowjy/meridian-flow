/** Routed project Trash list and read-only trashed-document view. */
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { useDocumentTrash, useTrashedDocument } from "@/client/query/useDocumentTrash";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { documentLocationName } from "../../chat/document-display-name";
import { daysUntilPurge } from "../deletion-retention";
import { RuledList } from "../RuledList";
import {
  useCaptureProjectNavigation,
  useProjectTrashNavigation,
} from "../routing/ProjectNavigationContext";
import { documentLocation, schemeLabel } from "./context-schemes";
import { useOpenProjectDocument } from "./open-project-document";
import { type RemovalVoice, removalVoice } from "./RemovedDocumentNotice";
import { restoreTrashedDocument, type TrashRestoreOutcome } from "./restore-trashed-document";
import { ReadOnlyViewerFrame } from "./viewers/ReadOnlyViewerFrame";
import { TextViewer } from "./viewers/TextViewer";

type RowState = { kind: "restoring" } | { kind: "failed"; message: string };
type TrashEntry = DocumentTrashEntry;
type AfterRestore = (
  outcome: Extract<TrashRestoreOutcome, { kind: "living" }>,
) => Promise<string | null>;

type RestoredNotice = { id: number; location: string };

export function DocumentTrashDialog({ projectId }: { projectId: string }) {
  const { destination, navigate } = useProjectTrashNavigation();
  const documentId = typeof destination === "string" ? destination : null;
  const queryClient = useQueryClient();
  const [restored, setRestored] = useState<RestoredNotice | null>(null);
  const [restoreStates, setRestoreStates] = useState<ReadonlyMap<string, RowState>>(
    () => new Map(),
  );
  const restoring = useMemo(
    () => [...restoreStates.values()].some((state) => state.kind === "restoring"),
    [restoreStates],
  );
  const dismissRestored = useCallback(() => setRestored(null), []);
  const restore = useCallback(
    (entry: TrashEntry, afterRestore?: AfterRestore) => {
      if (restoreStates.get(entry.documentId)?.kind === "restoring") return;
      setRestoreStates((current) => new Map(current).set(entry.documentId, { kind: "restoring" }));
      void restoreTrashedDocument(queryClient, projectId, entry)
        .then(async (outcome) => {
          if (outcome.kind === "living") {
            const failure = afterRestore ? await afterRestore(outcome) : null;
            if (failure) {
              setRestoreStates((current) =>
                new Map(current).set(entry.documentId, { kind: "failed", message: failure }),
              );
            } else {
              setRestoreStates((current) => {
                const next = new Map(current);
                next.delete(entry.documentId);
                return next;
              });
            }
            if (outcome.landedAt)
              setRestored({ id: Date.now(), location: documentLocationName(outcome.landedAt) });
            return;
          }
          if (outcome.kind === "superseded") {
            setRestoreStates((current) => {
              const next = new Map(current);
              next.delete(entry.documentId);
              return next;
            });
            return;
          }
          setRestoreStates((current) =>
            new Map(current).set(entry.documentId, {
              kind: "failed",
              message: restoreFailureMessage(entry.name, outcome.kind),
            }),
          );
        })
        .catch(() =>
          setRestoreStates((current) =>
            new Map(current).set(entry.documentId, {
              kind: "failed",
              message: restoreFailureMessage(entry.name, "network"),
            }),
          ),
        );
    },
    [projectId, queryClient, restoreStates],
  );

  return (
    <>
      <Dialog
        open={destination !== undefined}
        onOpenChange={(open) => !open && !restoring && void navigate(false)}
      >
        <DialogContent
          className={
            documentId
              ? "flex h-[min(48rem,calc(100%-2rem))] max-h-[calc(100%-2rem)] max-w-[min(56rem,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0"
              : "flex max-h-[min(42rem,calc(100%-2rem))] max-w-[min(40rem,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0"
          }
        >
          {documentId ? (
            <TrashedDocumentView
              key={documentId}
              projectId={projectId}
              documentId={documentId}
              onBack={() => void navigate(true)}
              state={restoreStates.get(documentId)}
              onRestore={restore}
            />
          ) : (
            <DocumentTrashList
              projectId={projectId}
              onOpenDocument={(id) => void navigate(id)}
              states={restoreStates}
              onRestore={restore}
            />
          )}
        </DialogContent>
      </Dialog>
      <RestoredAtNotice notice={restored} onDismiss={dismissRestored} />
    </>
  );
}

function DocumentTrashList({
  projectId,
  onOpenDocument,
  states,
  onRestore,
}: {
  projectId: string;
  onOpenDocument: (documentId: string) => void;
  states: ReadonlyMap<string, RowState>;
  onRestore: (entry: TrashEntry) => void;
}) {
  const query = useDocumentTrash(projectId);

  return (
    <>
      <header className="shrink-0 border-b border-border-subtle px-5 py-4">
        <DialogTitle>
          <Trans>Trash</Trans>
        </DialogTitle>
        <DialogDescription className="sr-only">
          <Trans>Deleted documents.</Trans>
        </DialogDescription>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {query.isError ? (
          <InlineErrorRow message={t`Couldn't load Trash.`} onRetry={() => void query.refetch()} />
        ) : query.data?.documents.length ? (
          <RuledList
            rows={query.data.documents.map((entry) => {
              return {
                key: entry.documentId,
                node: (
                  <TrashRow
                    entry={entry}
                    state={states.get(entry.documentId)}
                    onOpen={() => onOpenDocument(entry.documentId)}
                    onRestore={() => onRestore(entry)}
                  />
                ),
              };
            })}
          />
        ) : query.isPending ? (
          <p role="status" className="px-2 py-3 text-sm text-muted-foreground">
            <Trans>Loading Trash…</Trans>
          </p>
        ) : (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            <Trans>Trash is empty.</Trans>
          </p>
        )}
      </div>
    </>
  );
}

function TrashRow({
  entry,
  state,
  onOpen,
  onRestore,
}: {
  entry: TrashEntry;
  state?: RowState;
  onOpen: () => void;
  onRestore: () => void;
}) {
  const { i18n } = useLingui();
  const folder = entry.formerPath.split("/").slice(0, -1).join("/");
  const location = documentLocation(entry.scheme, folder) || schemeLabel(entry.scheme);
  const actor = removalActor(entry);
  const deleted = new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" }).format(
    new Date(entry.removal.time),
  );
  const retention = retentionSentence(entry, i18n.locale, "list");
  const restoring = state?.kind === "restoring";
  return (
    <div className="px-2 py-2.5">
      <div className="flex min-w-0 items-center gap-4">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-sm font-medium text-foreground">{entry.name}</span>
          <span className="block truncate text-xs text-ink-subtle">{location}</span>
          <span className="block text-xs text-muted-foreground">
            <Trans>
              Deleted by {actor} on {deleted}
            </Trans>
          </span>
          <span className="block text-xs text-ink-subtle">{retention}</span>
        </button>
        <button
          type="button"
          disabled={restoring}
          onClick={onRestore}
          className="text-button shrink-0 text-sm disabled:text-muted-foreground [@media(pointer:coarse)]:min-h-11"
        >
          {restoring ? <Trans>Restoring</Trans> : <Trans>Restore</Trans>}
        </button>
      </div>
      {state?.kind === "failed" ? (
        <p role="alert" className="pt-1 text-xs text-destructive">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

function TrashedDocumentView({
  projectId,
  documentId,
  onBack,
  state,
  onRestore,
}: {
  projectId: string;
  documentId: string;
  onBack: () => void;
  state?: RowState;
  onRestore: (entry: TrashEntry, afterRestore?: AfterRestore) => void;
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
  }, [captureNavigation, document, documentId, onRestore, openDocument, projectId, state?.kind]);

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2">
        <Button variant="quiet" size="sm" onClick={onBack}>
          <ChevronLeft className="size-4" aria-hidden />
          <Trans>Trash</Trans>
        </Button>
        <DialogTitle className="sr-only">{document?.name ?? t`Trashed document`}</DialogTitle>
        <DialogDescription className="sr-only">
          <Trans>Read-only document in Trash.</Trans>
        </DialogDescription>
      </header>
      <div className="min-h-0 flex-1">
        {query.isError ? (
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
        ) : query.isPending || !document ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            <Trans>Loading document…</Trans>
          </p>
        ) : (
          <ReadOnlyViewerFrame header={{ name: document.name, path: document.formerPath }}>
            <div className="flex h-full min-h-0 flex-col">
              <TrashNotice
                entry={document}
                locale={i18n.locale}
                state={state}
                onRestore={restore}
              />
              <div className="min-h-0 flex-1">
                <TextViewer source={{ content: document.markdown }} name={document.name} markdown />
              </div>
            </div>
          </ReadOnlyViewerFrame>
        )}
      </div>
    </>
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
  state?: RowState;
  onRestore: () => void;
}) {
  const actor = removalActor(entry);
  const deleted = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
    new Date(entry.removal.time),
  );
  const retention = retentionSentence(entry, locale, "notice");
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

function RestoredAtNotice({
  notice,
  onDismiss,
}: {
  notice: RestoredNotice | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(onDismiss, 4_000);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);
  if (!notice) return null;
  return (
    <div
      key={notice.id}
      role="status"
      className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-md bg-foreground px-3 py-1.5 text-background text-caption shadow-card"
    >
      <Trans>Restored at {notice.location}.</Trans>
    </div>
  );
}

function restoreFailureMessage(
  name: string,
  outcome: "superseded" | "ancestor_taken" | "refused" | "network",
): string {
  if (outcome === "ancestor_taken") return t`Couldn't restore ${name}. A file is in the way.`;
  if (outcome === "network") return t`Couldn't restore ${name}. Try again.`;
  return t`Couldn't restore ${name}.`;
}

function retentionSentence(entry: TrashEntry, locale: string, surface: "list" | "notice"): string {
  if (entry.retention.kind === "held") {
    const works = new Intl.ListFormat(locale, { type: "conjunction" }).format(
      entry.retention.works.map(({ name }) => name),
    );
    return entry.retention.works.length === 1
      ? t`Kept while ${works} has changes to it.`
      : t`Kept while ${works} have changes to it.`;
  }
  const days = daysUntilPurge(entry.retention.purgeAt, Date.now());
  if (surface === "list")
    return days <= 1
      ? t`Less than a day left`
      : plural(days, { one: "# day left", other: "# days left" });
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
