/**
 * The chat's Scratch, reached from the foot of the left rail.
 *
 * `RailScratchControl` is one full-width row above the account: the Scratch
 * icon, the label and an up chevron. The menu's heading names whose Scratch it is.
 * On desktop it opens `DrillInMenu` upwards; on a phone it asks the project to
 * open `ChatScratchSheet` (the drawer closes first, so the sheet lives outside
 * it). Both list the chat's Scratch: the lineage's notes for a No Work chat,
 * the Work's for a chat on a named Work, with any lineage notes left behind by
 * a rebind under "Earlier notes". Picking a note opens it beside the chat
 * (`useOpenScratchNote`). The list is notes only: the AI makes them, and there
 * is no New note. The control shows for every chat, empty or not, so the rail
 * never shifts when the first note lands.
 */
import { t } from "@lingui/core/macro";
import { ChevronUp } from "lucide-react";
import type { ComponentProps } from "react";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import { workFromSnapshot } from "@/client/query/works-projection-acquisition";
import { DrillInMenu, type DrillNode } from "@/components/app/DrillInMenu";
import { DrillInSheet } from "@/components/app/DrillInSheet";
import { chatScratchOwner } from "@/features/chat/chat-scratch-owner";
import { cn } from "@/lib/utils";
import { schemeIcon, schemeLabel } from "../context/context-schemes";
import { useCatalogMenuSource } from "../context/use-catalog-menu-source";
import { useOpenScratchNote } from "../dock/use-open-scratch-note";

/** The chat's Scratch menu source, or null while the chat is unknown (the control hides). */
function useChatScratch(projectId: string, threadId: string | null) {
  const { threads } = useProjectThreads(projectId);
  const { works, noWork } = useWorks(projectId);
  const thread = threadId
    ? (threads?.find((candidate) => candidate.id === threadId) ?? null)
    : null;
  const work =
    thread?.workId && noWork
      ? workFromSnapshot({ works: works ?? [], noWork }, thread.workId)
      : null;
  const owner = chatScratchOwner({ thread, work });
  const source = useCatalogMenuSource({
    projectId,
    owner:
      owner?.kind === "lineage"
        ? { rootThreadId: owner.rootThreadId }
        : { workId: owner?.workId ?? null },
    // A chat rebound onto a Work keeps its lineage's notes findable.
    earlierRootThreadId: owner?.kind === "work" ? (thread?.rootThreadId ?? null) : null,
    // The rail always means the chat on screen, so a chat's own notes need no name.
    heading:
      owner?.kind === "work" && work
        ? t`Scratch for ${work.name}`
        : owner?.kind === "lineage"
          ? t`Scratch for this chat`
          : schemeLabel("scratch"),
  });
  const openNote = useOpenScratchNote();
  if (!owner || !thread) return null;
  return {
    source,
    pick: (node: DrillNode) => {
      const tab = source.tabFor(node.id);
      if (!tab) return false;
      openNote(tab);
      return true;
    },
  };
}

type RailScratchControlProps = {
  projectId: string;
  /** The chat on screen: the centre chat on the Chat screen, the dock's chat elsewhere. */
  threadId: string | null;
  /** A phone opens the sheet instead of a menu; the project owns the sheet. */
  onOpenSheet?: () => void;
};

export function RailScratchControl({ projectId, threadId, onOpenSheet }: RailScratchControlProps) {
  const scratch = useChatScratch(projectId, threadId);
  if (!scratch) return null;
  if (onOpenSheet) return <ScratchRow phone onClick={onOpenSheet} />;
  return (
    <DrillInMenu
      tree={scratch.source.tree}
      currentId={null}
      openAt={[]}
      actions={[]}
      side="top"
      onPick={(node) => void scratch.pick(node)}
    >
      <ScratchRow phone={false} />
    </DrillInMenu>
  );
}

function ScratchRow({ phone, className, ...props }: ComponentProps<"button"> & { phone: boolean }) {
  const Icon = schemeIcon("scratch");
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "focus-ring flex w-full items-center gap-2.5 rounded-md px-2 text-left text-sm text-ink-muted transition-colors hover:bg-sidebar-accent/50 hover:text-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground",
        phone ? "min-h-12 active:scale-[0.98]" : "min-h-9",
        className,
      )}
    >
      <span className="grid size-5 place-items-center text-muted-foreground">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        {schemeLabel("scratch")}
      </span>
      <ChevronUp className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

/** The phone's Scratch list, opened from the drawer's control. */
export function ChatScratchSheet({
  projectId,
  threadId,
  open,
  onOpenChange,
}: {
  projectId: string;
  threadId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const scratch = useChatScratch(projectId, threadId);
  if (!scratch) return null;
  return (
    <DrillInSheet
      open={open}
      onOpenChange={onOpenChange}
      tree={scratch.source.tree}
      currentId={null}
      openAt={[]}
      onPick={(node) => {
        if (scratch.pick(node)) onOpenChange(false);
      }}
    />
  );
}
