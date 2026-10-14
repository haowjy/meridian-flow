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
import { useEffect, useRef, useState } from "react";
import {
  draftCommandFailure,
  draftOverrode,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHeadlessDiscards } from "@/features/draft-review/useHeadlessDiscards";
import { useWorkDraftCommands } from "@/features/draft-review/useWorkDraftCommands";
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
  const controller = useWorkDraftCommands({ projectId, work });
  const drafts = useWorkDrafts(projectId, workId);
  const discards = useHeadlessDiscards(projectId, workId);
  const touch = usePhoneShell() === true;
  const listed = drafts.files ?? [];
  const records = useDraftCommandRecords();
  // A file the server stops listing stays while it holds a failure or an overwrite notice, until that is
  // dismissed or resolved: the writer must not see a refused Apply vanish as if it had succeeded.
  const seen = useRef<{ workId: string; files: Map<string, ReviewFileTarget> }>({
    workId,
    files: new Map(),
  });
  if (seen.current.workId !== workId) seen.current = { workId, files: new Map() };
  for (const file of listed) seen.current.files.set(file.draft.itemKey, file);
  const noticed = [...seen.current.files.values()].filter((file) => {
    const draft = { projectId, workId, documentId: file.documentId, itemKey: file.draft.itemKey };
    return (
      !listed.some((other) => other.draft.itemKey === file.draft.itemKey) &&
      (draftCommandFailure(records, draft) !== null || draftOverrode(records, draft).length > 0)
    );
  });
  // A file stays on the page while one of its Discards can still be undone, even once the server stops listing it.
  const files = [
    ...listed,
    ...noticed,
    ...discards.entries
      .filter(
        (entry) =>
          ![...listed, ...noticed].some((file) => file.draft.itemKey === entry.file.draft.itemKey),
      )
      .map((entry) => entry.file)
      .filter(
        (file, at, all) =>
          all.findIndex((other) => other.draft.itemKey === file.draft.itemKey) === at,
      ),
  ];
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const hasFiles = files.length > 0;
  useEffect(() => {
    if (!hasFiles) setConfirmingDiscard(false);
  }, [hasFiles]);
  const visible = files.filter((file) =>
    matchesSearch(file.documentName || file.contextLocation?.path || ""),
  );
  if (listed.length === 0 && discards.entries.length === 0 && drafts.status === "error") {
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

  // Apply all and Discard all act on the Work's listed items, never on a row only kept for its Undo. Discard
  // all is one `discard_draft`: the draft closes on the server, so a reply still writing opens a new draft
  // instead of adding to one the writer discarded (per-row Discard keeps its Undo; this one is confirmed first).
  const everyDraft = listed.map((file) => ({
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
        rows={[
          ...visible.map((file) => ({
            key: file.documentId,
            node: (
              <WorkChangeFile
                projectId={projectId}
                workId={workId}
                file={file}
                controller={controller}
                discards={discards}
                touch={touch}
              />
            ),
          })),
        ]}
      />
    </WorkFileGroup>
  );
}
