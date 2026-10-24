/** Routed read-only view of one trashed project document. */
import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";
import { ArchiveRestore } from "lucide-react";
import { useCallback } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { useTrashedDocument } from "@/client/query/useDocumentTrash";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { daysUntilPurge } from "../deletion-retention";
import {
  useCaptureProjectNavigation,
  useProjectTrashNavigation,
} from "../routing/ProjectNavigationContext";
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
  const documentId = typeof destination === "string" ? destination : null;
  const { states, restoring, restore } = useDocumentTrashRestore();

  return (
    <Dialog
      open={documentId !== null}
      onOpenChange={(open) => !open && !restoring && void navigate(false)}
    >
      <DialogContent className="flex h-[min(48rem,calc(100%-2rem))] max-h-[calc(100%-2rem)] max-w-[min(56rem,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0">
        {documentId ? (
          <TrashedDocumentView
            key={documentId}
            projectId={projectId}
            documentId={documentId}
            state={states.get(documentId)}
            onRestore={restore}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TrashedDocumentView({
  projectId,
  documentId,
  state,
  onRestore,
}: {
  projectId: string;
  documentId: string;
  state?: TrashRestoreState;
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
      <DialogTitle className="sr-only">{document?.name ?? t`Trashed document`}</DialogTitle>
      <DialogDescription className="sr-only">
        <Trans>Read-only document in Trash.</Trans>
      </DialogDescription>
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
