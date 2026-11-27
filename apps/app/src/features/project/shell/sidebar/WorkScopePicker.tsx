import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadListItem } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { useMemo } from "react";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import { WorkIdentity } from "@/components/app/WorkIdentity";
import { WorkName } from "@/components/app/WorkName";
import { Chip } from "@/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  useMenuActionDispatch,
} from "@/components/ui/dropdown-menu";
import { ChooserMark, LabelNote } from "@/components/ui/marks";
import { role } from "@/components/ui/roles";
import { cn } from "@/lib/utils";
import { useWorkReviewCount } from "../../tree-version";
import { useBringWorkBack } from "../../work/EndedWorkNotice";
import { workStateIn } from "../../work/work-state";
import { useChangesScope } from "./ChangesSource";

export function WorkScopePicker({
  projectId,
  chatThreadId,
  workId,
  onPick,
  onManage,
}: {
  projectId: string;
  chatThreadId: string | null;
  workId: string | null;
  onPick: (workId: string) => void;
  onManage: () => void;
}) {
  const { works, deleted, noWork, nameOf } = useWorks(projectId);
  const bringBack = useBringWorkBack(projectId);
  const { threads } = useProjectThreads(projectId);
  const needsYou = useMemo(() => countNeedsYou(threads), [threads]);
  const active = works?.filter((work) => work.archivedAt === null) ?? [];
  const archived = works?.filter((work) => work.archivedAt !== null) ?? [];
  const state = workStateIn({ works, deleted }, workId);
  const scoped = state.kind === "unknown" ? null : state.work;
  const ended = state.kind === "ended" ? state : null;
  const scopedName = ended ? nameOf(ended.work) : "";
  const noWorkScoped = workId !== null && workId === noWork?.id;
  const changes = useChangesScope(projectId, chatThreadId);
  const pending = changes.count;
  const shown = changes.work && !changes.work.isNoWork ? changes.work : scoped;
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "focus-ring mx-2 flex h-8 coarse:h-11 shrink-0 items-center gap-2 rounded-md px-2 text-left",
            role.row,
            role.selected,
          )}
        >
          {shown || noWorkScoped ? (
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <WorkIdentity
                work={shown ?? noWork}
                unavailableLabel={t`None`}
                className="min-w-0 font-medium"
              />
              {ended && shown === ended.work ? (
                <LabelNote className="shrink-0">
                  {ended.deleted ? <Trans>Deleted</Trans> : <Trans>Archived</Trans>}
                </LabelNote>
              ) : null}
            </span>
          ) : (
            <span className={cn("min-w-0 flex-1 truncate", role.secondary)}>
              <Trans>Loading Works…</Trans>
            </span>
          )}
          {pending > 0 ? (
            <Chip kind="count" tone="jade">
              <span aria-hidden>{pending}</span>
              <span className="sr-only">
                {plural(pending, { one: "# change to review", other: "# changes to review" })}
              </span>
            </Chip>
          ) : null}
          <ChooserMark />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)]"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {ended ? (
          <>
            <DropdownMenuItem onSelect={() => void bringBack(ended.work)}>
              {ended.deleted ? (
                <Trans>Restore {scopedName}</Trans>
              ) : (
                <Trans>Unarchive {scopedName}</Trans>
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {noWork ? (
          <PickRow name={t`None`} selected={noWorkScoped} onSelect={() => onPick(noWork.id)} />
        ) : null}
        {active.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            {active.map((work) => (
              <PickRow
                key={work.id}
                name={<WorkName work={work} />}
                selected={work.id === scoped?.id}
                onSelect={() => onPick(work.id)}
                note={<WorkState work={work} needsYou={needsYou.get(work.id) ?? 0} />}
              />
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        {archived.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Trans>Archived</Trans>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {archived.map((work) => (
                <PickRow
                  key={work.id}
                  name={<WorkName work={work} />}
                  selected={work.id === scoped?.id}
                  onSelect={() => onPick(work.id)}
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuItem onSelect={() => dispatch(onManage)}>
          <Trans>Manage Works…</Trans>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PickRow({
  name,
  selected,
  onSelect,
  note,
}: {
  name: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
  note?: React.ReactNode;
}) {
  return (
    <DropdownMenuItem selected={selected} onSelect={onSelect} note={note}>
      <span className="flex min-w-0 flex-1">{name}</span>
    </DropdownMenuItem>
  );
}

function WorkState({ work, needsYou }: { work: Work; needsYou: number }) {
  const toReview = useWorkReviewCount(work);
  if (toReview === 0 && needsYou === 0) return null;
  return (
    <span className="inline-flex gap-2 text-jade-text tabular-nums">
      {toReview > 0 ? <Trans>{toReview} to review</Trans> : null}
      {needsYou > 0 ? (
        <span>
          <Trans>{needsYou} waiting on you</Trans>
        </span>
      ) : null}
    </span>
  );
}

function countNeedsYou(threads: readonly ThreadListItem[] | null) {
  const counts = new Map<string, number>();
  for (const thread of threads ?? []) {
    if (!thread.actionRequired || thread.workId === null) continue;
    counts.set(thread.workId, (counts.get(thread.workId) ?? 0) + 1);
  }
  return counts;
}
