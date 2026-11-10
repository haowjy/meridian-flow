/**
 * Manage Works: every Work function the Work page had, in one dialog the Work picker opens.
 * A list (Active, Archived, Deleted; new, rename, archive, restore, delete with Undo) and one
 * Work's detail (goal and changes to review). The dialog never changes the Work scope or the
 * main view; "Show this Work" is the picker's own pick.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useRouterState } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWorks } from "@/client/query/useWorks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CreationDialog } from "@/features/creation/CreationDialog";
import { useWorkScope } from "../use-work-scope";
import { useCreateWork, useWorkCreationRecovery } from "./useWorkCreation";
import { useWorkDeletion } from "./useWorkDeletion";
import { WorkCollection, type WorksListTab } from "./WorkCollection";
import { WorkCreationDestination } from "./WorkCreationDestination";
import { type LeaveGuard, WorkDetail } from "./WorkDetail";

const ManageWorksContext = createContext<{ open: () => void } | null>(null);

/** Opens the Manage Works dialog; null outside a project. */
export function useManageWorks(): { open: () => void } | null {
  return useContext(ManageWorksContext);
}

export function ManageWorksProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open: () => setOpen(true) }), []);
  return (
    <ManageWorksContext.Provider value={value}>
      {children}
      {open ? <ManageWorksDialog projectId={projectId} onClose={() => setOpen(false)} /> : null}
    </ManageWorksContext.Provider>
  );
}

type View = { kind: "list" } | { kind: "work"; workId: string };

function ManageWorksDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [listTab, setListTab] = useState<WorksListTab>("active");
  const [creating, setCreating] = useState(false);
  const deletion = useWorkDeletion(projectId);
  const createWork = useCreateWork(projectId);
  const scope = useWorkScope(projectId);
  const guard = useRef<LeaveGuard | null>(null);
  const setGuard = useCallback((next: LeaveGuard | null) => {
    guard.current = next;
  }, []);
  const leaveVia = (leave: () => void) => (guard.current ? guard.current(leave) : leave());
  const close = () => {
    deletion.dismissAll();
    onClose();
  };
  // A change row opens its review in main: the dialog gets out of its way.
  const href = useRouterState({ select: (state) => state.location.href });
  const openedAt = useRef(href);
  useEffect(() => {
    if (href !== openedAt.current) onClose();
  }, [href, onClose]);
  const openWork = (workId: string) => {
    deletion.dismissAll();
    setView({ kind: "work", workId });
  };
  const toList = () => setView({ kind: "list" });

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : leaveVia(close))}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col gap-3">
        <DialogHeader>
          <div className="flex items-center gap-2">
            {view.kind === "work" ? (
              <Button
                size="icon"
                variant="ghost"
                aria-label={t`Back to all Work`}
                onClick={() => leaveVia(toList)}
              >
                <ArrowLeft aria-hidden />
              </Button>
            ) : null}
            <DialogTitle>
              <Trans>Manage Works</Trans>
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            <Trans>
              Create, rename, archive, restore and delete Works, and review their changes.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {view.kind === "list" ? (
            <WorkCollection
              projectId={projectId}
              view={listTab}
              onViewChange={setListTab}
              onOpen={openWork}
              onNew={() => {
                deletion.dismissAll();
                setCreating(true);
              }}
              deletion={deletion}
            />
          ) : (
            <OpenedWork
              projectId={projectId}
              workId={view.workId}
              deletion={deletion}
              onBack={toList}
              onGuard={setGuard}
              onShowWork={(workId) => {
                scope.setWorkId(workId);
                close();
              }}
            />
          )}
        </div>
        {creating ? (
          <CreationDialog
            title={t`Create a Work`}
            nameLabel={t`What are you working on?`}
            namePlaceholder={t`Name this Work`}
            details={{
              label: t`What is your goal?`,
              placeholder: t`Draft chapters 12 to 15, the tournament arc, ending on Lin’s loss.`,
            }}
            submitLabel={t`Create Work`}
            onClose={() => setCreating(false)}
            onCreate={({ name, details }) => {
              // Navigate first: the Work opens at once, in its creating state until the server answers.
              setView({
                kind: "work",
                workId: createWork.create({ name, goal: details || undefined }),
              });
              setCreating(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function OpenedWork({
  projectId,
  workId,
  deletion,
  onBack,
  onGuard,
  onShowWork,
}: {
  projectId: string;
  workId: string;
  deletion: ReturnType<typeof useWorkDeletion>;
  onBack: () => void;
  onGuard: (guard: LeaveGuard | null) => void;
  onShowWork: (workId: string) => void;
}) {
  const { works, creations, noWork } = useWorks(projectId);
  const recovery = useWorkCreationRecovery(projectId, workId, onBack);
  const work = works?.find((entry) => entry.id === workId);
  const creation = creations.get(workId);
  if (work && work.id !== noWork?.id)
    return (
      // Keyed: goal edits and the changes list belong to one Work.
      <WorkDetail
        key={work.id}
        projectId={projectId}
        work={work}
        deletion={deletion}
        onDeleted={onBack}
        onGuard={onGuard}
        onShowWork={onShowWork}
      />
    );
  if (creation)
    return (
      <WorkCreationDestination
        name={creation.work.name}
        goal={creation.work.goal}
        failed={creation.phase === "failed"}
        onRetry={recovery.retry}
        onDiscard={recovery.discard}
      />
    );
  return (
    <p className="text-sm text-muted-foreground">
      <Trans>This Work is unavailable.</Trans>
    </p>
  );
}
