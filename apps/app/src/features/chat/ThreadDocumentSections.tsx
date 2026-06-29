/**
 * ThreadDocumentSections — the data-bound Uploads + Recent sections for a thread,
 * shared by the context rail (`ContextRail`) and the thread-contents popover
 * (`ThreadContentsPopover`). Owns the two thread-document queries AND the canonical
 * section copy, so the two surfaces render identical content and cannot drift.
 *
 * Display lives in `ThreadDocumentList` (container-agnostic primitives); this is the
 * single place that binds those primitives to the thread-document hooks. Rows become
 * selectable (clickable, with an active highlight) only when `onSelectDocument` is
 * provided — the rail omits it, the popover passes it.
 */
import { t } from "@lingui/core/macro";
import { FileText, Upload } from "lucide-react";

import { useThreadRecentDocuments } from "@/client/query/useThreadRecentDocuments";
import { useThreadUploads } from "@/client/query/useThreadUploads";

import { DocumentRailSection } from "./ThreadDocumentList";

export function ThreadDocumentSections({
  threadId,
  activeDocumentId,
  onSelectDocument,
}: {
  threadId: string | null;
  activeDocumentId?: string | null;
  onSelectDocument?: (documentId: string) => void;
}) {
  const uploads = useThreadUploads(threadId);
  const recent = useThreadRecentDocuments(threadId);

  return (
    <>
      <DocumentRailSection
        title={t`Uploads`}
        icon={<Upload className="size-3.5" />}
        defaultOpen
        status={uploads}
        rows={uploads.uploads}
        messages={{
          disabled: t`Open a chat to see its uploads.`,
          loading: t`Loading uploads…`,
          empty: t`No files uploaded yet.`,
          error: t`Couldn't load uploads.`,
        }}
        activeDocumentId={activeDocumentId}
        onSelectDocument={onSelectDocument}
      />
      <DocumentRailSection
        title={t`Recent`}
        icon={<FileText className="size-3.5" />}
        defaultOpen
        status={recent}
        rows={recent.documents}
        messages={{
          disabled: t`Open a chat to see what the AI touched.`,
          loading: t`Loading recent documents…`,
          empty: t`Documents the AI touches in this chat appear here.`,
          error: t`Couldn't load recent documents.`,
        }}
        activeDocumentId={activeDocumentId}
        onSelectDocument={onSelectDocument}
      />
    </>
  );
}
