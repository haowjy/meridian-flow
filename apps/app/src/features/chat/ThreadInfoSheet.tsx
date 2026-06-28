/**
 * ThreadInfoSheet — a right-edge slide-over "peek" at thread-scoped metadata:
 * what the user uploaded into this thread and what the agent recently touched.
 *
 * PROTOTYPE: this is the sheet/drawer alternative to the view-swap thread info
 * design (open question #5 in context-surface-redesign.md). The sheet overlays
 * the chat rather than replacing it — the bet is that thread info is a quick
 * glance you dismiss, not a destination you dwell in. Rows are not yet
 * clickable; file-opening wiring is intentionally out of scope here.
 *
 * Self-contained: owns its own trigger button and open state, so it drops into
 * any chat header (centered `PaneHeader.actions` or the dock `RailHeader`)
 * without threading state through the parent. The Radix Dialog portals to the
 * document body, so trigger placement doesn't constrain where the panel lands.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FileText, Info, Settings2, Upload } from "lucide-react";

import { useThreadRecentDocuments } from "@/client/query/useThreadRecentDocuments";
import { useThreadUploads } from "@/client/query/useThreadUploads";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

import { DocumentRailSection, EmptyHint, Section } from "./ThreadDocumentList";

export type ThreadInfoSheetProps = {
  /** Active thread; when null, sections render their disabled empty state. */
  threadId: string | null;
};

export function ThreadInfoSheet({ threadId }: ThreadInfoSheetProps) {
  const uploads = useThreadUploads(threadId);
  // Recent currently returns all touches (reads + writes). Showing all is fine
  // for the prototype — narrowing to writes-only is open question #2.
  const recent = useThreadRecentDocuments(threadId);

  return (
    <Sheet>
      <SheetTrigger
        type="button"
        aria-label={t`Thread info`}
        title={t`Thread info`}
        className="focus-ring grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
      >
        <Info className="size-4" aria-hidden />
      </SheetTrigger>
      <SheetContent side="right" className="w-80 gap-0 sm:max-w-xs">
        <SheetHeader className="h-10 flex-row items-center gap-0 border-b border-border-subtle px-3 py-0">
          <SheetTitle className="text-sm">
            <Trans>Thread info</Trans>
          </SheetTitle>
        </SheetHeader>
        <SheetDescription className="sr-only">
          <Trans>Uploads and recent writes for this thread.</Trans>
        </SheetDescription>

        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-2 py-2">
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
          />
          <Section
            title={t`Thread settings`}
            icon={<Settings2 className="size-3.5" />}
            count={null}
            defaultOpen
          >
            <EmptyHint>
              <Trans>Per-thread model and prompt settings are coming soon.</Trans>
            </EmptyHint>
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
