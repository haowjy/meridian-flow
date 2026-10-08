/**
 * ChatScratchButton — the chat header's Scratch menu.
 *
 * Lists the chat's Scratch: the lineage's notes for a No Work chat, the Work's
 * for a chat on a named Work, with any lineage notes left behind by a rebind
 * under "Earlier notes". Folders open in place (a drop-down on desktop, a
 * bottom sheet on a phone); picking a note opens it beside the chat
 * (`useOpenScratchNote`). It lists notes only: the AI makes them, and there is
 * no New note. The button shows once there is a note to open, so a chat that
 * has none keeps a quiet header.
 */
import { t } from "@lingui/core/macro";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useLineageTitle } from "@/client/query/useLineageTitle";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks } from "@/client/query/useWorks";
import { workFromSnapshot } from "@/client/query/works-projection-acquisition";
import { DrillInMenu, type DrillNode } from "@/components/app/DrillInMenu";
import { DrillInSheet } from "@/components/app/DrillInSheet";
import { Button } from "@/components/ui/button";
import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { chatScratchOwner } from "@/features/chat/chat-scratch-owner";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { schemeIcon, schemeLabel } from "../context/context-schemes";
import { useCatalogMenuSource } from "../context/use-catalog-menu-source";
import { useOpenScratchNote } from "../dock/use-open-scratch-note";

export function ChatScratchButton({
  projectId,
  threadId,
  onOpened,
}: {
  projectId: string;
  threadId: string | null;
  /** Called after a phone picks a note, so the chat sheet closes over the document it opened. */
  onOpened?: () => void;
}) {
  const phone = usePhoneShell();
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
  const lineageTitle = useLineageTitle(
    projectId,
    owner?.kind === "lineage" ? { rootThreadId: owner.rootThreadId } : null,
  );
  const name = owner?.kind === "work" ? work?.name : lineageTitle;
  const source = useCatalogMenuSource({
    projectId,
    owner:
      owner?.kind === "lineage"
        ? { rootThreadId: owner.rootThreadId }
        : { workId: owner?.workId ?? null },
    // A chat rebound onto a Work keeps its lineage's notes findable.
    earlierRootThreadId: owner?.kind === "work" ? (thread?.rootThreadId ?? null) : null,
    heading: name ? t`Scratch for ${name}` : schemeLabel("scratch"),
  });
  const openNote = useOpenScratchNote();
  const [sheetOpen, setSheetOpen] = useState(false);
  if (!owner || !source.hasNotes) return null;

  const pick = (node: DrillNode) => {
    const tab = source.tabFor(node.id);
    if (!tab) return;
    setSheetOpen(false);
    openNote(tab);
    if (phone) onOpened?.();
  };
  const Icon = schemeIcon("scratch");

  if (phone) {
    return (
      <>
        <PhoneIconButton aria-label={t`Scratch`} onClick={() => setSheetOpen(true)}>
          <Icon className="size-5" aria-hidden />
        </PhoneIconButton>
        <DrillInSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          tree={source.tree}
          currentId={null}
          openAt={[]}
          onPick={pick}
        />
      </>
    );
  }
  return (
    <DrillInMenu tree={source.tree} currentId={null} openAt={[]} actions={[]} onPick={pick}>
      <Button variant="quiet" size="sm" className="shrink-0">
        <Icon aria-hidden />
        {schemeLabel("scratch")}
        <ChevronDown aria-hidden />
      </Button>
    </DrillInMenu>
  );
}
