/**
 * WorkChanges — the Work page's "Changes to review": every draft file of the
 * Work in the one file order (`sortDraftFiles`), each expandable in place to its
 * changes (`WorkChangeFile`). The group's `…` menu holds Apply all and Discard
 * all, the creation-bound whole-Work batch (`disposeDrafts`). They act on every draft of the Work whatever the
 * search box filters, new documents, moves, deletes and formatting-only drafts included, and
 * only a change row uses the per-change selection
 * commands. Discard all asks first, in the group's footer below the rows; so
 * does an Apply all that would delete documents or bring back documents deleted from the
 * manuscript (D79), naming each, and again for any a newer delete held back.
 *
 * Nothing shows until the Work has something to review: no loading flash and no
 * empty group. A list that cannot be read says so, with Retry.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Work } from "@meridian/contracts/works";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useWorkBranchDrafts } from "@/client/query/useWorkBranchDrafts";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ApplyAllQuestion,
  CommandNotice,
  type CommandQuestion,
} from "@/features/draft-review/CommandNotice";
import { isDeletedFromManuscript } from "@/features/draft-review/deleted-drafts";
import { reviewFileTargetName } from "@/features/draft-review/review-files";
import { hasTreeLine } from "@/features/draft-review/tree-line";
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
  useSyncExternalStore(
    controller.owner.subscribe,
    controller.owner.snapshot,
    controller.owner.snapshot,
  );
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
      hasTreeLine(file.draft) ||
      read?.status !== "ready" ||
      read.listedChanges.length > 0 ||
      controller.owner.state(file.draft.itemKey).pending ||
      controller.owner.state(file.draft.itemKey).failure
    );
  });
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  /** What an Apply all asks about first: the documents it deletes and those it brings back. */
  const [asking, setAsking] = useState<{
    deleting: readonly ReviewFileTarget[];
    restoring: readonly ReviewFileTarget[];
  } | null>(null);
  const hasFiles = files.length > 0;
  useEffect(() => {
    if (hasFiles) return;
    setConfirmingDiscard(false);
    setAsking(null);
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
  const discardAll = () => void controller.disposeDrafts("discard", everyDraft);
  const ids = (targets: readonly ReviewFileTarget[]) =>
    new Set(targets.map((file) => file.documentId));
  // Brings back only the named documents; a delete the list hadn't shown yet asks again.
  const applyAll = (restore: ReadonlySet<string>) =>
    void controller.disposeDrafts("apply", everyDraft, restore).then((outcomes) => {
      const heldBack = files.filter((_file, index) => outcomes[index]?.kind === "needs-restore");
      if (heldBack.length > 0) setAsking({ deleting: [], restoring: heldBack });
    });
  const startApplyAll = () => {
    const restoring = files.filter((file) => isDeletedFromManuscript(file.draft));
    const deleting = files.filter((file) => file.draft.tree?.deleted === true);
    if (restoring.length > 0 || deleting.length > 0) setAsking({ deleting, restoring });
    else applyAll(new Set());
  };
  const untitled = t`Untitled document`;
  // One question at a time, in the footer below the rows: opening it never moves a row.
  const names = (targets: readonly ReviewFileTarget[]) =>
    targets.map((file) => reviewFileTargetName(file, untitled));
  const question: CommandQuestion | null = asking
    ? {
        kind: "apply-all",
        sentence: (
          <ApplyAllQuestion deleting={names(asking.deleting)} restoring={names(asking.restoring)} />
        ),
        keep: <Trans>Cancel</Trans>,
        confirm: <Trans>Apply all</Trans>,
        onKeep: () => setAsking(null),
        onConfirm: () => {
          setAsking(null);
          applyAll(ids(asking.restoring));
        },
        disabled: controller.dispositionLocked,
      }
    : confirmingDiscard
      ? {
          kind: "discard",
          sentence: (
            <>
              <Trans>Discard all changes?</Trans>{" "}
              <Trans>This removes pending changes from every document in this Work.</Trans>
            </>
          ),
          keep: <Trans>Keep</Trans>,
          confirm: <Trans>Discard</Trans>,
          onKeep: () => setConfirmingDiscard(false),
          onConfirm: () => {
            setConfirmingDiscard(false);
            discardAll();
          },
          disabled: controller.dispositionLocked,
        }
      : null;

  return (
    <WorkFileGroup
      label={t`Changes to review`}
      actions={
        confirmingDiscard || asking ? null : (
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
                  hasTreeLine(file.draft) ||
                  (file.draft.hasDraft &&
                    (held[textRows.findIndex((row) => row.draft.itemKey === file.draft.itemKey)]
                      ?.frame?.groups.length ?? 0) > 0),
              ) ? (
                <DropdownMenuItem
                  disabled={
                    controller.dispositionLocked || held.some((read) => read.status !== "ready")
                  }
                  onSelect={startApplyAll}
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
      <CommandNotice commands={controller} question={question} />
    </WorkFileGroup>
  );
}
