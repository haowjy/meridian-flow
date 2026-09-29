/**
 * The Work page: its titles and description over one sticky toolbar, then
 * the Chats or Files tab, each owning its own search, actions and queries.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useRef, useState } from "react";
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
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { useProjectLeaveGuard } from "../routing/ProjectNavigationContext";
import type { ProjectRouteCommands } from "../routing/project-route";
import { WorkChatsTab } from "./WorkChatsTab";
import { WorkFilesTab } from "./WorkFilesTab";
import {
  useWorkMetadataController,
  WorkDescription,
  type WorkMetadataController,
} from "./WorkMetadata";
import { WorkHeading } from "./WorkTitles";
import { WorkToolbarSlotProvider } from "./WorkToolbarSlot";

export type WorkDetailScreenProps = {
  projectId: string;
  work: AddressableWork;
  routeCommands: ProjectRouteCommands;
};

/**
 * The Work page's own header block under the band: the description (or a
 * pending Work's state), then one sticky toolbar row.
 */
export function WorkScreenHeader({
  description,
  view,
  onViewChange,
  tools,
  pending = false,
}: {
  description?: React.ReactNode;
  view: "chats" | "files";
  onViewChange: (view: "chats" | "files") => void;
  tools: React.ReactNode;
  pending?: boolean;
}) {
  return (
    <>
      {description ? (
        <header className="flex min-w-0 flex-col gap-1.5">{description}</header>
      ) : null}
      <div className="sticky top-0 z-10 -my-2 flex min-w-0 items-center gap-2 bg-background py-2 sm:gap-3">
        <SegmentedTabs
          label={t`Work view`}
          value={view}
          onChange={onViewChange}
          options={[
            { value: "chats", label: <Trans>Chats</Trans>, disabled: pending },
            { value: "files", label: <Trans>Files</Trans>, disabled: pending },
          ]}
        />
        {tools}
      </div>
    </>
  );
}

export function WorkDetailScreen({ projectId, work, routeCommands }: WorkDetailScreenProps) {
  const mutations = useWorkMutations(projectId);
  const controller = useWorkMetadataController(work, async (data) => {
    const error = await mutations.update({ workId: work.id, data });
    if (error) throw error;
  });
  const scrollOwner = useRef<HTMLDivElement>(null);
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);
  useProjectLeaveGuard({
    request: controller.request,
    dirty: () => controller.dirty,
    cancel: controller.keepEditing,
  });
  return (
    <div ref={scrollOwner} className="app-scroll">
      <article className="project-screen-column min-w-0 gap-5 pb-12">
        <WorkScreenHeader
          description={
            <>
              <WorkHeading projectId={projectId} work={work} />
              <WorkDescription work={work} controller={controller} />
            </>
          }
          view={routeCommands.workView}
          onViewChange={(view) => void routeCommands.setWorkView(view)}
          tools={<div ref={setToolbarSlot} className="contents" />}
        />
        <WorkToolbarSlotProvider value={toolbarSlot}>
          {routeCommands.workView === "chats" ? (
            <WorkChatsTab projectId={projectId} workId={work.id} scrollOwner={scrollOwner} />
          ) : (
            <WorkFilesTab projectId={projectId} work={work} commands={routeCommands} />
          )}
        </WorkToolbarSlotProvider>
        <DirtyDecision controller={controller} />
      </article>
    </div>
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
            <Trans>Save description changes?</Trans>
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
