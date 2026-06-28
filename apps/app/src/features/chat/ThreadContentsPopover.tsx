/**
 * ThreadContentsPopover — sticky chat-header popover listing uploads and recent writes for the active thread.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FileText, Info, Upload, X } from "lucide-react";
import { useState } from "react";

import { useThreadRecentDocuments } from "@/client/query/useThreadRecentDocuments";
import { useThreadUploads } from "@/client/query/useThreadUploads";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { DocumentRailSection } from "./ThreadDocumentList";

export type ThreadContentsPopoverProps = {
  /** Active thread; when null, sections render their disabled empty state. */
  threadId: string | null;
  onOpenDocument?: (documentId: string) => void;
};

export function ThreadContentsPopover({ threadId, onOpenDocument }: ThreadContentsPopoverProps) {
  const [open, setOpen] = useState(false);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const uploads = useThreadUploads(threadId);
  const recent = useThreadRecentDocuments(threadId);

  function selectDocument(documentId: string) {
    setActiveDocumentId(documentId);
    // TODO(handoff): open document is deferred — design-lead to wire destination.
    onOpenDocument?.(documentId);
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger
        type="button"
        aria-label={t`Thread contents`}
        title={t`Thread contents`}
        className="focus-ring grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground data-[state=open]:bg-sidebar-accent/60 data-[state=open]:text-foreground"
      >
        <Info className="size-4" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 gap-0 p-0"
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
          <h2 className="text-sm font-semibold text-foreground">
            <Trans>Thread contents</Trans>
          </h2>
          <button
            type="button"
            aria-label={t`Close thread contents`}
            onClick={() => setOpen(false)}
            className="focus-ring grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="max-h-[min(24rem,50svh)] overflow-y-auto p-2">
          <div className="flex flex-col gap-0.5">
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
              onSelectDocument={selectDocument}
            />
            <DocumentRailSection
              title={t`Recent writes`}
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
              onSelectDocument={selectDocument}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
