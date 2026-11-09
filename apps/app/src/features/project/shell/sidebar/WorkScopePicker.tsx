import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadListItem } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import { Check, ChevronDown, Layers } from "lucide-react";
import { useMemo } from "react";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  const noWorkScoped = scoped === null && (workId === null || workId === noWork?.id);
  const pending = scoped?.pendingDocumentCount ?? 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="focus-ring mx-2 flex h-8 shrink-0 items-center gap-2 rounded-md border border-border-subtle bg-background/40 px-2 text-left text-[13px] hover:bg-background/70"
        >
          <Layers className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
          {noWorkScoped ? (
            <span className="min-w-0 flex-1 truncate text-ink-muted">
              <Trans>No Work</Trans>
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">
              <span className="text-ink-muted">
                <Trans>Work</Trans>
              </span>{" "}
              <span className="font-medium">{scoped?.name ?? t`Loading…`}</span>
            </span>
          )}
          {pending > 0 ? (
            <span
              className="rounded-full bg-primary/12 px-1.5 text-[11px] font-medium text-primary tabular-nums"
              title={t`${pending} documents with changes`}
            >
              {pending}
            </span>
          ) : null}
          <ChevronDown className="size-3.5 shrink-0 text-ink-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-64"
      >
        {noWork ? (
          <PickRow
            name={t`No Work`}
            selected={noWorkScoped}
            onSelect={() => onPick(noWork.id)}
            detail={null}
          />
        ) : null}
        {active.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-normal text-ink-subtle">
              <Trans>Active Works</Trans>
            </DropdownMenuLabel>
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

/** Only state that asks for action: pending changes and chats waiting on the writer. */
function WorkState({ work, needsYou }: { work: Work; needsYou: number }) {
  const changes = work.pendingDocumentCount;
  if (changes === 0 && needsYou === 0) return null;
  return (
    <span className="shrink-0 text-[11px] text-ink-muted tabular-nums">
      {changes > 0 ? <Trans>{changes} changes</Trans> : null}
      {changes > 0 && needsYou > 0 ? " · " : null}
      {needsYou > 0 ? (
        <span className="text-primary">
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
