/**
 * MainHeader — the band above main's page when main shows a document or the Recently opened
 * landing: the Recently opened door, the document's title (the page rises into it, and dragging
 * it into a chat makes a reference), the removed-documents notice and New document.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { History, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import type { OpenDocument } from "@/client/stores";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { draftCopyView } from "@/features/draft-review/copy-view";
import { holdFocus } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";
import { fileKindIcon } from "../context/context-file-icon";
import { useReferenceDrag } from "../context/entry-drag/reference-source";
import { RemovedDocumentChip, RemovedNoticeSlot } from "../context/RemovedDocumentNotice";
import { tabSubject } from "../context/tab-subject";
import { useIsDraftOnly } from "../context/use-is-draft-only";
import { useDocumentPaint } from "../views";
import { PaneHeader, type PaneHeaderRailToggle } from "./PaneHeader";
import { tabChipClass } from "./tab-chip";

export function MainHeader({
  projectId,
  document,
  onShowRecents,
  onNewDocument,
  sidebarToggle,
  sideToggle,
  closedSide,
}: {
  projectId: string;
  /** Main's document; null on the Recently opened landing, which the door then marks current. */
  document: OpenDocument | null;
  onShowRecents: () => void;
  /** Absent while no Work is ready to hold an Untitled document. */
  onNewDocument?: () => void;
  sidebarToggle: PaneHeaderRailToggle;
  sideToggle: PaneHeaderRailToggle;
  /** While the side is closed: the control naming what it would show. */
  closedSide?: ReactNode;
}) {
  return (
    <PaneHeader
      left={sidebarToggle}
      right={sideToggle}
      leading={<RecentlyOpenedDoor active={document === null} onClick={onShowRecents} />}
      title={
        <div className="flex h-full min-w-0 flex-1 items-stretch">
          {document ? <DocumentTitleChip projectId={projectId} document={document} /> : null}
          <RemovedNoticeSlot>
            <RemovedDocumentChip projectId={projectId} />
          </RemovedNoticeSlot>
        </div>
      }
      actions={
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onNewDocument}
                disabled={!onNewDocument}
                title={!onNewDocument ? t`Open a Work to create an Untitled document` : undefined}
                aria-label={t`New document`}
                className="focus-ring relative isolate grid size-8 shrink-0 place-items-center text-muted-foreground before:absolute before:inset-0 before:-z-10 before:rounded-md before:transition-colors hover:text-foreground hover:before:bg-ink-fill"
              >
                <Plus className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <Trans>New document</Trans>
            </TooltipContent>
          </Tooltip>
          {/* Last, beside the toggle that opens it. */}
          {closedSide}
        </>
      }
    />
  );
}

/** The page's own title: the active chip, a drag source for a reference to what it shows. */
function DocumentTitleChip({ projectId, document }: { projectId: string; document: OpenDocument }) {
  const paint = useDocumentPaint(projectId, document);
  const drafts = useOwnerDrafts(projectId, paint.draft?.ownerKey ?? null);
  const file = paint.draft ? drafts.fileForDocument(document.documentId) : null;
  const reviewing = paint.showing === "draft";
  const isDraftOnly = useIsDraftOnly(projectId);
  const drag = useReferenceDrag(
    tabSubject(
      document,
      {
        reviewing,
        view: file && paint.draft ? draftCopyView(file, paint.draft.ownerKey) : null,
      },
      isDraftOnly(document.documentId),
    ),
  );
  const Icon = fileKindIcon(document.name);
  return (
    <div
      {...drag}
      title={document.kind === "new" ? document.name : document.path}
      className={cn(
        "min-w-0 max-w-64 shrink gap-1.5",
        tabChipClass(true),
        reviewing && "[--tab-chip-surface:var(--color-review)]",
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-xs">{document.name}</span>
    </div>
  );
}

/**
 * The door to Recently opened, icon only, right after the sidebar toggle. Current while the
 * landing is the page below (the page rises into it).
 */
function RecentlyOpenedDoor({ active, onClick }: { active: boolean; onClick: () => void }) {
  const label = t`Recently opened`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(event) => {
            const focused = event.currentTarget === document.activeElement;
            onClick();
            // The landing is main's own page with its own header: the focus follows to its door.
            if (focused)
              holdFocus(() => document.querySelector("[data-recents-door][aria-current]"));
          }}
          data-recents-door
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn("focus-ring shrink-0", tabChipClass(active))}
        >
          <History className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
