import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadListItem } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { Check, ChevronsUpDown } from "lucide-react";
import { useMemo } from "react";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import { WorkIdentity } from "@/components/app/WorkIdentity";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The Work scope under the project name: which Work's drafts the documents show
 * and whose chats the Chat list holds. A lens, not a move: picking a Work never
 * changes the open chapter or chat, and never rebinds a chat.
 */
export function WorkScopePicker({
  projectId,
  workId,
  onPick,
  onManage,
}: {
  projectId: string;
  /** The scoped Work's id, the No Work row's included. */
  workId: string | null;
  onPick: (workId: string) => void;
  /** Today's Work page, for New Work, rename and archive until they move here. */
  onManage: () => void;
}) {
  const { works, noWork } = useWorks(projectId);
  const { threads } = useProjectThreads(projectId);
  const needsYou = useMemo(() => countNeedsYou(threads), [threads]);
  const active = works?.filter((work) => work.archivedAt === null) ?? [];
  const archived = works?.filter((work) => work.archivedAt !== null) ?? [];
  const scoped = works?.find((work) => work.id === workId) ?? null;
  const noWorkScoped = workId !== null && workId === noWork?.id;
  const pending = scoped?.pendingDocumentCount ?? 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The Work in scope is state, not a link: it rests on the selected fill, like the selected tab. */}
        <button
          type="button"
          className="focus-ring mx-2 flex h-8 shrink-0 items-center gap-2 rounded-md bg-sidebar-accent/60 px-2 text-left text-[13px] hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent"
        >
          {scoped || noWorkScoped ? (
            <WorkIdentity
              name={scoped ? scoped.name : t`None`}
              unavailableLabel={t`None`}
              className="flex-1 text-[13px]"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-ink-muted">
              <Trans>Loading Works…</Trans>
            </span>
          )}
          {pending > 0 ? (
            <span
              className="rounded-full bg-primary/12 px-1.5 text-[11px] font-medium text-primary tabular-nums"
              title={t`${pending} documents to review`}
            >
              {pending}
            </span>
          ) : null}
          <ChevronsUpDown className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
        {noWork ? (
          <PickRow
            name={t`None`}
            selected={noWorkScoped}
            onSelect={() => onPick(noWork.id)}
            detail={null}
          />
        ) : null}
        {active.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            {active.map((work) => (
              <PickRow
                key={work.id}
                name={work.name}
                selected={work.id === scoped?.id}
                onSelect={() => onPick(work.id)}
                detail={<WorkState work={work} needsYou={needsYou.get(work.id) ?? 0} />}
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
                  name={work.name}
                  selected={work.id === scoped?.id}
                  onSelect={() => onPick(work.id)}
                  detail={null}
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuItem onSelect={onManage}>
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
  detail,
}: {
  name: string;
  selected: boolean;
  onSelect: () => void;
  detail: React.ReactNode;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="gap-2">
      <Check
        className={cn("size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {detail}
    </DropdownMenuItem>
  );
}

/** Only state that asks for action: documents to review and chats waiting on the writer. */
function WorkState({ work, needsYou }: { work: Work; needsYou: number }) {
  const toReview = work.pendingDocumentCount;
  if (toReview === 0 && needsYou === 0) return null;
  return (
    <span className="flex shrink-0 gap-2 text-[11px] text-primary tabular-nums">
      {toReview > 0 ? <Trans>{toReview} to review</Trans> : null}
      {needsYou > 0 ? (
        <span>
          <Trans>{needsYou} needs you</Trans>
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
