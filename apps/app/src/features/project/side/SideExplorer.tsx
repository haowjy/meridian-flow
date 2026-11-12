import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useProject } from "@/client/query/useProjectList";
import { type DrillNode, useDrill } from "@/components/app/DrillInMenu";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { PickerSection } from "@/components/ui/picker";
import { useOnScreenChatScratchSource } from "../chat/use-chat-scratch-source";
import { useProjectMenuSource } from "../context/use-project-menu-source";

const NO_TRAIL: readonly DrillNode[] = [];

/**
 * The file explorer the side offers beside a chat: the project's areas (manuscript://, the KB,
 * ...) as the drill-in menu lists them (`useDrill`), stepping into folders in place. Picking a
 * file hands its document to `onPick`.
 */
export function SideExplorer({
  projectId,
  current,
  fits,
  catalogs,
  onPick,
}: {
  projectId: string;
  /** The document the side shows, marked in its folder. */
  current: string | null;
  /** Whether a document can sit beside; leaves that can't are listed disabled. */
  fits: (documentId: string) => boolean;
  /** How the catalogs behind the folders are doing: what an empty folder means. */
  catalogs: "ready" | "loading" | "failed";
  onPick: (documentId: string) => void;
}) {
  const project = useProject(projectId);
  const scratch = useOnScreenChatScratchSource(projectId);
  const { tree } = useProjectMenuSource({
    projectId,
    title: project?.title ?? "",
    scratch,
    own: null,
  });
  const { scopeRef, folder, entries, enter, back } = useDrill({
    tree,
    hereIds: current ? [current] : [],
    openAt: NO_TRAIL,
    isDisabled: (node) => !node.folder && node.documentId !== undefined && !fits(node.documentId),
    rowSelector: "[data-list-item]:not(:disabled)",
  });
  return (
    <div ref={scopeRef}>
      <PickerSection
        state={
          folder && entries.length === 0 && catalogs !== "ready" ? (
            <ListLine density="menu" iconSlot status={catalogs === "loading"}>
              {catalogs === "loading" ? (
                <Trans>Loading…</Trans>
              ) : (
                <Trans>Couldn't open this folder.</Trans>
              )}
            </ListLine>
          ) : undefined
        }
      >
        {folder ? (
          <li>
            <ListRow
              density="menu"
              onOpen={back}
              leading={
                <ChevronLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              }
              title={folder.title ?? folder.name}
              controlProps={{ "aria-label": t`Back from ${folder.title ?? folder.name}` }}
            />
          </li>
        ) : null}
        {entries.map(({ node, here, disabled }) => (
          <li key={node.id}>
            <ListRow
              density="menu"
              current={here}
              disabled={disabled}
              onOpen={() => (node.folder ? enter(node) : onPick(node.documentId ?? node.id))}
              leading={<node.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
              title={node.name}
              trailing={
                node.folder ? (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : undefined
              }
            />
          </li>
        ))}
      </PickerSection>
    </div>
  );
}
