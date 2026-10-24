/** Routed project Trash list and read-only trashed-document view. */
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArchiveRestore, ChevronLeft } from "lucide-react";
import { useCallback, useState } from "react";
import { useDocumentTrash, useTrashedDocument } from "@/client/query/useDocumentTrash";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RuledList } from "../RuledList";
import { documentLocation, schemeLabel } from "./context-schemes";
import { useOpenProjectDocument } from "./open-project-document";
import { restoreTrashedDocument } from "./restore-trashed-document";
import { ReadOnlyViewerFrame } from "./viewers/ReadOnlyViewerFrame";
import { TextViewer } from "./viewers/TextViewer";

type RowState = { kind: "restoring" } | { kind: "failed"; message: string };

export function useDocumentTrashNavigation() {
  const navigate = useNavigate();
  return useCallback(
    (destination: boolean | string) => {
      void navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => ({
          ...previous,
          trash: destination || undefined,
        }),
        state: (previous) => previous,
      });
    },
    [navigate],
  );
}

export function DocumentTrashDialog({ projectId }: { projectId: string }) {
  const search = useSearch({ strict: false }) as { trash?: true | string };
  const setOpen = useDocumentTrashNavigation();
  const documentId = typeof search.trash === "string" ? search.trash : null;

  return (
    <Dialog open={search.trash !== undefined} onOpenChange={(open) => !open && setOpen(false)}>
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
            onBack={() => setOpen(true)}
            onClose={() => setOpen(false)}
          />
        ) : (
          <DocumentTrashList projectId={projectId} onOpenDocument={setOpen} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DocumentTrashList({
  projectId,
  onOpenDocument,
}: {
  projectId: string;
  onOpenDocument: (documentId: string) => void;
}) {
  const query = useDocumentTrash(projectId);
  const queryClient = useQueryClient();
  const [rowStates, setRowStates] = useState<ReadonlyMap<string, RowState>>(() => new Map());

  const restore = useCallback(
    (entry: DocumentTrashEntry) => {
      if (rowStates.get(entry.documentId)?.kind === "restoring") return;
      setRowStates((current) => new Map(current).set(entry.documentId, { kind: "restoring" }));
      void restoreTrashedDocument(queryClient, projectId, entry)
        .then((outcome) => {
          if (outcome === "living") {
            setRowStates((current) => {
              const next = new Map(current);
              next.delete(entry.documentId);
              return next;
            });
            return;
          }
          if (outcome === "superseded") {
            setRowStates((current) => {
              const next = new Map(current);
              next.delete(entry.documentId);
              return next;
            });
            return;
          }
          setRowStates((current) =>
            new Map(current).set(entry.documentId, {
              kind: "failed",
              message:
                outcome === "ancestor_taken"
                  ? t`Couldn't restore ${entry.name}. A file is in the way.`
                  : t`Couldn't restore ${entry.name}.`,
            }),
          );
        })
        .catch(() =>
          setRowStates((current) =>
            new Map(current).set(entry.documentId, {
              kind: "failed",
              message: t`Couldn't restore ${entry.name}. Try again.`,
            }),
          ),
        );
    },
    [projectId, queryClient, rowStates],
  );

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
            rows={query.data.documents.map((entry) => ({
              key: entry.documentId,
              node: (
                <TrashRow
                  entry={entry}
                  state={rowStates.get(entry.documentId)}
                  onOpen={() => onOpenDocument(entry.documentId)}
                  onRestore={() => restore(entry)}
                />
              ),
            }))}
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
  entry: DocumentTrashEntry;
  state?: RowState;
  onOpen: () => void;
  onRestore: () => void;
}) {
  const { i18n } = useLingui();
  const folder = entry.formerPath.split("/").slice(0, -1).join("/");
  const location = documentLocation(entry.scheme, folder) || schemeLabel(entry.scheme);
  const actor = removalActor(entry);
  const deleted = new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" }).format(
    new Date(entry.deletedAt),
  );
  const days = Math.max(0, Math.ceil((Date.parse(entry.purgeAt) - Date.now()) / 86_400_000));
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
          <span className="block text-xs text-ink-subtle">
            {days <= 1
              ? t`Less than a day left`
              : plural(days, { one: "# day left", other: "# days left" })}
          </span>
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
  onClose,
}: {
  projectId: string;
  documentId: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const { i18n } = useLingui();
  const query = useTrashedDocument(projectId, documentId);
  const queryClient = useQueryClient();
  const openDocument = useOpenProjectDocument(projectId);
  const [state, setState] = useState<RowState>();
  const document = query.data;

  const restore = useCallback(() => {
    if (!document || state?.kind === "restoring") return;
    setState({ kind: "restoring" });
    void restoreTrashedDocument(queryClient, projectId, document)
      .then(async (outcome) => {
        if (outcome === "living" || outcome === "superseded") {
          await openDocument({ documentId, disposition: "current" });
          onClose();
          return;
        }
        setState({
          kind: "failed",
          message:
            outcome === "ancestor_taken"
              ? t`Couldn't restore ${document.name}. A file is in the way.`
              : t`Couldn't restore ${document.name}.`,
        });
      })
      .catch(() =>
        setState({ kind: "failed", message: t`Couldn't restore ${document.name}. Try again.` }),
      );
  }, [document, documentId, onClose, openDocument, projectId, queryClient, state?.kind]);

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
            <InlineErrorRow
              message={t`Couldn't load this document.`}
              onRetry={() => void query.refetch()}
            />
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
  entry: DocumentTrashEntry;
  locale: string;
  state?: RowState;
  onRestore: () => void;
}) {
  const actor = removalActor(entry);
  const deleted = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
    new Date(entry.deletedAt),
  );
  const days = Math.max(0, Math.ceil((Date.parse(entry.purgeAt) - Date.now()) / 86_400_000));
  const remaining = plural(days, {
    one: "Gone for good in # day.",
    other: "Gone for good in # days.",
  });
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
          {remaining}
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

function removalActor(entry: DocumentTrashEntry): string {
  switch (entry.actor?.kind) {
    case "user":
      return entry.actor.displayName?.trim() || t`a writer`;
    case "agent":
      return entry.actor.chatTitle ? t`AI in ${entry.actor.chatTitle}` : t`AI in a chat`;
    case "work":
      return entry.actor.name;
    case "system":
      return t`the system`;
    default:
      return t`an unknown writer`;
  }
}
