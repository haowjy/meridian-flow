/**
 * Main's view of a deleted document: its text read-only, who deleted it, and Restore. Whether it
 * is in Trash or purged is the list's answer, and the text is the document's own session, so what
 * the writer typed offline is there. The server adds only the retention details.
 */

import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { DocumentTrashEntry } from "@meridian/contracts/protocol";
import { ArchiveRestore } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { useTrashedDocument } from "@/client/query/useDocumentTrash";
import { DocumentNotice } from "@/components/app/DocumentNotice";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { role } from "@/components/ui/roles";
import { PROSEMIRROR_FRAGMENT_NAME } from "@/core/editor/schema";
import { roomContent } from "@/features/draft-review/review-frame";
import { cn } from "@/lib/utils";
import { daysUntilPurge } from "../deletion-retention";
import { useAccountId } from "./account-feature-context";
import { documentPlace } from "./context-schemes";
import { useDocumentTrashRestore } from "./DocumentTrashRestoreProvider";
import { useOpenProjectDocument } from "./open-project-document";
import { type RemovalVoice, removalVoice } from "./RemovedDocumentNotice";
import { useDocumentStanding } from "./use-document-standing";
import { useLiveDocumentBinding } from "./use-live-document-binding";
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
  const accountId = useAccountId();
  const standing = useDocumentStanding(projectId, documentId);
  const trashed = standing.kind === "in-trash";
  const details = useTrashedDocument(projectId, trashed ? documentId : null).data;
  const binding = useLiveDocumentBinding({
    projectId,
    documentId: trashed ? documentId : null,
    owner: "trash-view",
    trashed: true,
  });
  const text = useSessionText(
    binding.state.kind === "opened" ? binding.state.session.document : null,
  );
  const { states, restore } = useDocumentTrashRestore();
  const state = states.get(documentId);
  const openFailed = useOpenOnceLiving(
    projectId,
    documentId,
    state?.kind,
    standing.kind === "in-tree",
  );

  if (standing.kind === "purged" || standing.kind === "not-in-list") {
    return (
      <div className="p-4">
        <p className={role.emptyLine}>
          {standing.kind === "purged" ? (
            <Trans>Gone for good: this document was emptied from Trash.</Trans>
          ) : (
            <Trans>No longer available</Trans>
          )}
        </p>
      </div>
    );
  }
  if (standing.kind === "waiting" || binding.state.kind === "opening") {
    return (
      <p role="status" className={cn("px-4 pt-3", role.emptyLine)}>
        <Trans>Loading document…</Trans>
      </p>
    );
  }
  if (binding.state.kind === "failed") {
    return (
      <div className="p-4">
        <InlineErrorRow message={t`Couldn't load this document.`} onRetry={binding.retry} />
      </div>
    );
  }
  const name = standing.kind === "in-trash" ? standing.node.name : "";
  const failure =
    state?.kind === "failed"
      ? state.message
      : openFailed
        ? t`Restored ${name}, but couldn't open it. Try again from the file list.`
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
                onClick={() => standing.kind === "in-trash" && restore([{ documentId, name }])}
              >
                <Trans>Restore</Trans>
              </Button>
            }
          >
            {details ? trashSentence(details, i18n.locale, accountId) : t`Deleted.`}
          </DocumentNotice>
          {failure ? <InlineErrorRow message={failure} className="px-0 pt-2 pb-0" /> : null}
        </div>
        <div className="min-h-0 flex-1">
          <TextViewer source={{ content: text }} name={name} markdown />
        </div>
      </div>
    </ReadOnlyViewerFrame>
  );
}

/** The document's text as its session holds it now, offline typing included. */
function useSessionText(document: Y.Doc | null): string {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!document) return;
    const fragment = document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    const read = () => {
      const { doc } = roomContent(document);
      setText(doc.textBetween(0, doc.content.size, "\n\n"));
    };
    read();
    fragment.observeDeep(read);
    return () => fragment.unobserveDeep(read);
  }, [document]);
  return text;
}

/**
 * Main follows the document out of Trash, wherever it was restored from (this Restore, the
 * sidebar's, a drag out), and an address naming a document no longer in Trash goes to it once.
 * One open leaves the view: the list changing again must not start another, which would cancel
 * this one and lose its failure. Returns whether that open failed.
 */
function useOpenOnceLiving(
  projectId: string,
  documentId: string,
  restore: "restored" | "failed" | undefined,
  living: boolean,
): boolean {
  const openDocument = useOpenProjectDocument(projectId);
  const [failed, setFailed] = useState(false);
  const leaving = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const restored = restore === "restored";
    if (leaving.current || (!restored && !living)) return;
    leaving.current = true;
    void openDocument({ documentId, replace: true }).then((outcome) => {
      if (restored && mounted.current && outcome.kind === "refused") setFailed(true);
    });
  }, [restore, living, documentId, openDocument]);
  return failed;
}

function trashSentence(entry: DocumentTrashEntry, locale: string, accountId: string): string {
  const place = documentPlace(entry.scheme, entry.formerPath);
  const time = new Date(entry.removal.time);
  const deleted = new Intl.DateTimeFormat(
    locale,
    time.getFullYear() === new Date().getFullYear()
      ? { month: "short", day: "numeric" }
      : { dateStyle: "medium" },
  ).format(time);
  return `${deletedSentence(entry, place, deleted, accountId)} ${retentionSentence(entry, locale)}`;
}

/**
 * Names who deleted it only when that says something: you, another writer, a chat's AI or a Work,
 * in `RemovedDocumentNotice`'s words.
 */
function deletedSentence(
  entry: DocumentTrashEntry,
  place: string,
  deleted: string,
  accountId: string,
): string {
  if (entry.actor?.kind === "user" && entry.actor.userId === accountId)
    return t`Deleted from ${place} by you on ${deleted}.`;
  const voice: RemovalVoice = removalVoice({
    actor: entry.actor,
    time: entry.removal.time,
  });
  switch (voice.kind) {
    case "person": {
      const { name } = voice;
      return t`Deleted from ${place} by ${name} on ${deleted}.`;
    }
    case "agent": {
      const { chat } = voice;
      return chat
        ? t`Deleted from ${place} by the AI in ${chat} on ${deleted}.`
        : t`Deleted from ${place} by the AI in a chat on ${deleted}.`;
    }
    case "work": {
      const { name } = voice;
      return t`Deleted from ${place} with the Work ${name} on ${deleted}.`;
    }
    case "anonymous":
      return t`Deleted from ${place} on ${deleted}.`;
  }
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
