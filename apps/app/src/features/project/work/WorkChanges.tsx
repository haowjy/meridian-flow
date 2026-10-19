/**
 * WorkChanges — the Work page's "Changes to review": every draft file of the
 * Work in the one file order (`sortDraftFiles`), each expandable in place to its
 * changes (`WorkChangeFile`). The group's `…` menu holds Apply all and Discard
 * all, the creation-bound whole-Work batch (`disposeDrafts`). They act on every draft of the Work whatever the
 * search box filters, new documents and formatting-only drafts included, and
 * only a change row uses the per-change selection
 * commands. Discard all asks first, inline, in the menu's place.
 *
 * Nothing shows until the Work has something to review: no loading flash and no
 * empty group. A list that cannot be read says so, with Retry.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { useWorkBranchDrafts } from "@/client/query/useWorkBranchDrafts";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DiscardNotice } from "@/features/draft-review/DiscardNotice";
import { useRoomReviews } from "@/features/draft-review/useRoomReview";
import { useWorkBranchCommands } from "@/features/draft-review/useWorkBranchCommands";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { RuledList } from "../RuledList";
import { WorkChangeFile } from "./WorkChangeFile";
import { WorkFileGroup } from "./WorkFileGroup";
import type { WorkFileSearch } from "./work-files-model";

export function WorkChanges({
  projectId,
  work,
  matchesSearch,
}: {
  projectId: string;
  work: Work;
  matchesSearch: WorkFileSearch;
}) {
  const workId = work.id;
  const controller = useWorkBranchCommands({ projectId, work });
  const drafts = useWorkBranchDrafts(projectId, workId);
  const held = useRoomReviews(
    (drafts.files ?? [])
      .filter((file) => file.draft.hasDraft)
      .map((file) => ({
        projectId,
        workId,
        documentId: file.documentId,
        itemKey: file.draft.itemKey,
      })),
  );
  const textRows = (drafts.files ?? []).filter((file) => file.draft.hasDraft);
  const touch = usePhoneShell() === true;
  const files = (drafts.files ?? []).filter((file) => {
    if (controller.owner.state(file.draft.itemKey).hidden) return false;
    const read = held[textRows.findIndex((row) => row.draft.itemKey === file.draft.itemKey)];
    return (
      file.draft.wholeItem ||
      read?.status !== "ready" ||
      read.listedChanges.length > 0 ||
      controller.owner.state(file.draft.itemKey).pending ||
      controller.owner.state(file.draft.itemKey).failure
    );
  });
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const hasFiles = files.length > 0;
  useEffect(() => {
    if (!hasFiles) setConfirmingDiscard(false);
  }, [hasFiles]);
  const visible = files.filter((file) =>
    matchesSearch(file.documentName || file.contextLocation?.path || ""),
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
  if (visible.length === 0 && !controller.notice) return null;

  const everyDraft = files.map((file) => ({
    documentId: file.documentId,
    itemKey: file.draft.itemKey,
  }));
  const dispose = (mode: "apply" | "discard") => void controller.disposeDrafts(mode, everyDraft);

  return (
    <WorkFileGroup
      label={t`Changes to review`}
      actions={
        confirmingDiscard ? null : (
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
              {files.every(
                (file) =>
                  (!file.draft.hasDraft && file.draft.isNew) ||
                  (file.draft.hasDraft &&
                    (held[textRows.findIndex((row) => row.draft.itemKey === file.draft.itemKey)]
                      ?.frame?.groups.length ?? 0) > 0),
              ) ? (
                <DropdownMenuItem
                  disabled={
                    controller.dispositionLocked || held.some((read) => read.status !== "ready")
                  }
                  onSelect={() => dispose("apply")}
                >
                  <Trans>Apply all changes</Trans>
                </DropdownMenuItem>
              ) : null}
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
      {confirmingDiscard ? (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 pb-2 text-xs">
          <span className="min-w-0 basis-full text-muted-foreground">
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
      ) : null}
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
      <DiscardNotice commands={controller} />
    </WorkFileGroup>
  );
}
