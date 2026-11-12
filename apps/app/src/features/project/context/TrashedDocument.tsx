/** Main's view of a deleted document: its text read-only, who deleted it, and Restore. */

import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";
import { ArchiveRestore } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { httpErrorStatus } from "@/client/api/http-client";
import { useTrashedDocument } from "@/client/query/useDocumentTrash";
import { DocumentNotice } from "@/components/app/DocumentNotice";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { role } from "@/components/ui/roles";
import { cn } from "@/lib/utils";
import { daysUntilPurge } from "../deletion-retention";
import { schemeLocation } from "./context-schemes";
import { useDocumentTrashRestore } from "./DocumentTrashRestoreProvider";
import { useOpenProjectDocument } from "./open-project-document";
import { type RemovalVoice, removalVoice } from "./RemovedDocumentNotice";
import { ReadOnlyViewerFrame } from "./viewers/ReadOnlyViewerFrame";
import { TextViewer } from "./viewers/TextViewer";

export function TrashedDocument({
  projectId,
  documentId,
}: {
  projectId: string;
  documentId: string;
}) {
  const { i18n } = useLingui();
  const query = useTrashedDocument(projectId, documentId);
  const { states, restore } = useDocumentTrashRestore();
  const state = states.get(documentId);
  const openFailed = useOpenOnceLiving(projectId, documentId, state?.kind, query.error);
  const document = query.data;

  if (query.isError) {
    return (
      <div className="p-4">
        {[404, 410].includes(httpErrorStatus(query.error) ?? 0) ? (
          <p className={role.emptyLine}>
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
      <p role="status" className={cn("px-4 pt-3", role.emptyLine)}>
        <Trans>Loading document…</Trans>
      </p>
    );
  }
  const failure =
    state?.kind === "failed"
      ? state.message
      : openFailed
        ? t`Restored ${document.name}, but couldn't open it. Try again from the file list.`
        : null;
  return (
    <ReadOnlyViewerFrame className="bg-transparent">
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 px-4 pt-3">
          <DocumentNotice
            icon={<ArchiveRestore className="size-4" aria-hidden />}
            action={
              <Button
                size="sm"
                variant="outline"
                disabled={state?.kind === "restoring"}
                onClick={() => restore([document])}
              >
                {state?.kind === "restoring" ? <Trans>Restoring</Trans> : <Trans>Restore</Trans>}
              </Button>
            }
          >
            {trashSentence(document, i18n.locale)}
          </DocumentNotice>
          {failure ? <InlineErrorRow message={failure} className="px-0 pt-2 pb-0" /> : null}
        </div>
        <div className="min-h-0 flex-1">
          <TextViewer source={{ content: document.markdown }} name={document.name} markdown />
        </div>
      </div>
    </ReadOnlyViewerFrame>
  );
}

/**
 * Main follows the document out of Trash, wherever it was restored from (this Restore, the
 * sidebar's, a drag out), and an address naming a document no longer in Trash goes to it once.
 * Returns whether that open failed.
 */
function useOpenOnceLiving(
  projectId: string,
  documentId: string,
  restore: "restoring" | "failed" | undefined,
  error: Error | null,
): boolean {
  const openDocument = useOpenProjectDocument(projectId);
  const [failed, setFailed] = useState(false);
  const restoring = useRef(false);
  const missing = [404, 410].includes(httpErrorStatus(error) ?? 0);
  useEffect(() => {
    if (restore === "restoring") {
      restoring.current = true;
      return;
    }
    const restored = restoring.current && restore === undefined;
    restoring.current = false;
    if (!restored && !missing) return;
    let current = true;
    void openDocument({ documentId, refreshIdentity: true, replace: true }).then((outcome) => {
      if (current && restored && outcome.kind === "refused") setFailed(true);
    });
    return () => {
      current = false;
    };
  }, [restore, missing, documentId, openDocument]);
  return failed;
}

function trashSentence(entry: DocumentTrashEntry, locale: string): string {
  const actor = removalActor(entry);
  const place = schemeLocation(entry.scheme, entry.formerPath.split("/").slice(0, -1));
  const deleted = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
    new Date(entry.removal.time),
  );
  return `${t`In the trash. Deleted from ${place} by ${actor} on ${deleted}.`} ${retentionSentence(entry, locale)}`;
}

function retentionSentence(entry: DocumentTrashEntry, locale: string): string {
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

function removalActor(entry: DocumentTrashEntry): string {
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
