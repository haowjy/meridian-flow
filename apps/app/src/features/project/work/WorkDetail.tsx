/**
 * One Work inside the Manage Works dialog: its name and the AI's status, and its goal. An archived
 * Work is view-only: one notice with Unarchive under the title, and no inline edits offered. Its
 * chats and files are the sidebar's, under that Work's scope.
 */
import { Trans } from "@lingui/react/macro";
import { isWorkArchived } from "@meridian/contracts/works";
import { useEffect } from "react";
import type { AddressableWork } from "@/client/query/useWorks";
import { useWorkMutations } from "@/client/query/work-command-store";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArchivedWorkNotice } from "./ArchivedWorkNotice";
import { useWorkArchiveToggle } from "./useWorkArchiveToggle";
import type { WorkDeletion } from "./useWorkDeletion";
import { WorkActionsMenu } from "./WorkActionsMenu";
import { useWorkMetadataController, WorkGoal, type WorkMetadataController } from "./WorkMetadata";
import { WorkTitleLine } from "./WorkTitleLine";
import { WorkHeading } from "./WorkTitles";

/** Asks before leaving with an unsaved goal edit; the dialog calls it for Back and close. */
export type LeaveGuard = (leave: () => void, cancel: () => void) => void;

export function WorkDetail({
  projectId,
  work,
  deletion,
  onDeleted,
  onGuard,
  onShowWork,
}: {
  projectId: string;
  work: AddressableWork;
  deletion: WorkDeletion;
  /** The Work was deleted from here: back to the list, where its Undo row is. */
  onDeleted: () => void;
  onGuard: (guard: LeaveGuard | null) => void;
  /** Makes this Work the scope, the way the picker does. */
  onShowWork: (workId: string) => void;
}) {
  const mutations = useWorkMutations(projectId);
  const toggleArchive = useWorkArchiveToggle(projectId);
  const controller = useWorkMetadataController(work, async (data) => {
    const error = await mutations.update({ workId: work.id, data });
    if (error) throw error;
  });
  const { request } = controller;
  useEffect(() => {
    onGuard((leave, cancel) => request({ run: leave, cancel }));
    return () => onGuard(null);
  }, [onGuard, request]);
  return (
    <article className="flex min-w-0 flex-col gap-4">
      <header className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <WorkTitleLine
              title={<WorkHeading projectId={projectId} work={work} />}
              status={work.status}
              size="heading"
            />
          </div>
          {isWorkArchived(work) ? null : (
            <Button size="sm" variant="outline" onClick={() => onShowWork(work.id)}>
              <Trans>Show this Work</Trans>
            </Button>
          )}
          <WorkActionsMenu
            work={work}
            onToggleArchive={() => void toggleArchive(work)}
            onDelete={() => {
              deletion.remove(work);
              onDeleted();
            }}
          />
        </div>
        {isWorkArchived(work) ? (
          <div className="mt-1.5 min-w-0">
            <ArchivedWorkNotice projectId={projectId} work={work} showFailure={false} />
          </div>
        ) : null}
        <WorkGoal work={work} controller={controller} />
      </header>
      <DirtyDecision controller={controller} />
    </article>
  );
}

function DirtyDecision({ controller }: { controller: WorkMetadataController }) {
  return (
    <Dialog open={Boolean(controller.held)} onOpenChange={() => undefined}>
      <DialogContent
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Save goal changes?</Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          <Trans>Choose what to do before continuing.</Trans>
        </p>
        {controller.error ? (
          <p role="alert" className="text-sm text-destructive">
            {controller.error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={controller.saving}
            onClick={controller.keepEditing}
            className="[@media(pointer:coarse)]:min-h-11"
          >
            <Trans>Keep editing</Trans>
          </Button>
          <Button
            variant="outline"
            disabled={controller.saving}
            onClick={controller.discardAndResume}
            className="[@media(pointer:coarse)]:min-h-11"
          >
            <Trans>Discard changes</Trans>
          </Button>
          <Button
            disabled={controller.saving}
            onClick={() => void controller.saveAndResume()}
            className="[@media(pointer:coarse)]:min-h-11"
          >
            {controller.saving ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
