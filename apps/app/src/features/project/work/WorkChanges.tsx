/**
 * WorkChanges — the Work page's "Changes to review": every draft file of the
 * Work in the one file order (`sortDraftFiles`), each expandable in place to its
 * changes (`WorkChangeFile`). The group's `…` menu holds Apply all and Discard
 * all, the whole-draft batch (`disposeDrafts`, with its `batchStarted` and
 * `batchSettled` lifecycle) run by the scope that covers this Work
 * (`useWorkReviewScope`). They act on every draft of the Work whatever the
 * search box filters, new documents and formatting-only drafts included, and
 * only a change row uses the per-change selection
 * commands. Discard all asks first, inline, in the menu's place.
 *
 * Nothing shows until the Work has something to review: no loading flash and no
 * empty group. A list that cannot be read says so, with Retry.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { RuledList } from "../RuledList";
import { useWorkReviewScope } from "./useWorkReviewScope";
import { WorkChangeFile } from "./WorkChangeFile";
import { WorkFileGroup } from "./WorkFileGroup";
import type { WorkFileSearch } from "./work-files-model";

export function WorkChanges({
  projectId,
  workId,
  matchesSearch,
}: {
  projectId: string;
  workId: ParsedRequestId;
  matchesSearch: WorkFileSearch;
}) {
  const scope = useWorkReviewScope(workId);
  const touch = usePhoneShell() === true;
  const files = scope?.files ?? [];
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const hasFiles = files.length > 0;
  useEffect(() => {
    if (!hasFiles) setConfirmingDiscard(false);
  }, [hasFiles]);
  // A null scope is the route Work still resolving: nothing to review yet.
  if (!scope) return null;

  const { controller, drafts } = scope;
  const visible = files.filter((file) =>
    matchesSearch(file.documentName || file.contextPath || ""),
  );
  if (files.length === 0 && drafts.status === "error") {
    return (
      <WorkFileGroup label={t`Changes to review`}>
        <InlineErrorRow
          message={t`Pending drafts couldn’t load`}
          onRetry={drafts.refetch}
          actionLabel={t`Retry Pending drafts`}
        />
      </WorkFileGroup>
    );
  }
  if (visible.length === 0) return null;

  const everyDraft = files.map((file) => ({
    documentId: file.documentId,
    draftId: file.draft.draftId,
  }));
  const dispose = (mode: "apply" | "discard") => void controller.disposeDrafts(mode, everyDraft);

  return (
    <WorkFileGroup
      label={t`Changes to review`}
      actions={
        confirmingDiscard ? (
          <div className="flex shrink-0 items-center gap-1 text-xs">
            <span className="text-muted-foreground">
              <Trans>Discard all changes?</Trans>{" "}
              <Trans>This removes pending changes from every document in this Work.</Trans>
            </span>
            <Button
              variant="quiet"
              size={touch ? "default" : "xs"}
              className={touch ? "min-h-11" : undefined}
              onClick={() => setConfirmingDiscard(false)}
            >
              <Trans>Keep</Trans>
            </Button>
            <Button
              variant="quiet"
              size={touch ? "default" : "xs"}
              className={touch ? "min-h-11" : undefined}
              disabled={controller.dispositionLocked}
              onClick={() => {
                setConfirmingDiscard(false);
                dispose("discard");
              }}
            >
              <Trans>Discard</Trans>
            </Button>
          </div>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="quiet"
                size="xs"
                className={touch ? "-my-2.5 size-11 p-0" : "size-6 p-0"}
                aria-label={t`All changes`}
              >
                <MoreHorizontal aria-hidden className={touch ? "size-5" : "size-3.5"} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                disabled={controller.dispositionLocked}
                onSelect={() => dispose("apply")}
              >
                <Trans>Apply all changes</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={controller.dispositionLocked}
                onSelect={() => setConfirmingDiscard(true)}
              >
                <Trans>Discard all changes</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      }
    >
      <RuledList
        className="-mx-2"
        rows={visible.map((file) => ({
          key: file.documentId,
          node: (
            <WorkChangeFile
              projectId={projectId}
              workId={workId}
              file={file}
              controller={controller}
              touch={touch}
            />
          ),
        }))}
      />
    </WorkFileGroup>
  );
}
