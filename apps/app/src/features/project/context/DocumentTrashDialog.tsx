/** Routed project trash list and row-local document restore commands. */
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { DocumentTrashEntry, ListDocumentTrashResponse } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { restoreContextDocuments } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useDocumentTrash } from "@/client/query/useDocumentTrash";
import { announce } from "@/client/stores";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RuledList } from "../RuledList";
import { documentLocation, schemeLabel } from "./context-schemes";

type RowState = { kind: "restoring" } | { kind: "failed"; message: string };

export function useDocumentTrashNavigation() {
  const navigate = useNavigate();
  return useCallback(
    (open: boolean) => {
      void navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => ({
          ...previous,
          trash: open ? (true as const) : undefined,
        }),
        state: (previous) => previous,
      });
    },
    [navigate],
  );
}

export function DocumentTrashDialog({ projectId }: { projectId: string }) {
  const search = useSearch({ strict: false }) as { trash?: boolean };
  const setOpen = useDocumentTrashNavigation();
  const query = useDocumentTrash(projectId);
  const queryClient = useQueryClient();
  const [rowStates, setRowStates] = useState<ReadonlyMap<string, RowState>>(() => new Map());

  const restore = useCallback(
    (entry: DocumentTrashEntry) => {
      if (rowStates.get(entry.documentId)?.kind === "restoring") return;
      setRowStates((current) => new Map(current).set(entry.documentId, { kind: "restoring" }));
      void restoreContextDocuments(projectId, {
        documents: [{ documentId: entry.documentId, removal: entry.removal }],
      })
        .then(({ documents }) => {
          const result = documents[0];
          if (!result) throw new Error("Restore returned no result");
          if (result.outcome === "restored" || result.outcome === "already_living") {
            queryClient.setQueryData<ListDocumentTrashResponse>(
              projectQueryKeys.documentTrash(projectId),
              (current) =>
                current
                  ? {
                      documents: current.documents.filter(
                        ({ documentId }) => documentId !== entry.documentId,
                      ),
                    }
                  : current,
            );
            setRowStates((current) => {
              const next = new Map(current);
              next.delete(entry.documentId);
              return next;
            });
            if (result.outcome === "restored" && result.landedAt)
              announce(t`Restored at ${result.landedAt}.`);
            return;
          }
          if (result.outcome === "superseded") {
            setRowStates((current) => {
              const next = new Map(current);
              next.delete(entry.documentId);
              return next;
            });
            void queryClient.invalidateQueries({
              queryKey: projectQueryKeys.documentTrash(projectId),
            });
            return;
          }
          setRowStates((current) =>
            new Map(current).set(entry.documentId, {
              kind: "failed",
              message:
                result.outcome === "ancestor_taken"
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
    <Dialog open={search.trash === true} onOpenChange={(open) => !open && setOpen(false)}>
      <DialogContent className="flex max-h-[min(42rem,calc(100%-2rem))] max-w-[min(40rem,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0">
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
            <InlineErrorRow
              message={t`Couldn't load Trash.`}
              onRetry={() => void query.refetch()}
            />
          ) : query.data?.documents.length ? (
            <RuledList
              rows={query.data.documents.map((entry) => ({
                key: entry.documentId,
                node: (
                  <TrashRow
                    entry={entry}
                    state={rowStates.get(entry.documentId)}
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
      </DialogContent>
    </Dialog>
  );
}

function TrashRow({
  entry,
  state,
  onRestore,
}: {
  entry: DocumentTrashEntry;
  state?: RowState;
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
        <div className="min-w-0 flex-1">
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
        </div>
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
