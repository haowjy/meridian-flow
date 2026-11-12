import { t } from "@lingui/core/macro";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useProject } from "@/client/query/useProjectList";
import type { DrillNode } from "@/components/app/DrillInMenu";
import { ListRow } from "@/components/ui/list-row";
import { PickerSection } from "@/components/ui/picker";
import { useOnScreenChatScratchSource } from "../chat/use-chat-scratch-source";
import { useProjectMenuSource } from "../context/use-project-menu-source";

/**
 * The file explorer the side offers beside a chat: the project's areas (manuscript://, the KB,
 * ...) as the drill-in menu lists them, stepping into folders in place. Picking a file hands its
 * document to `onPick`.
 */
export function SideExplorer({
  projectId,
  current,
  onPick,
}: {
  projectId: string;
  /** The document the side shows, marked in its folder. */
  current: string | null;
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
  const [trail, setTrail] = useState<readonly DrillNode[]>([]);
  const folder = trail.at(-1) ?? null;
  return (
    <PickerSection>
      {folder ? (
        <li>
          <ListRow
            density="menu"
            onOpen={() => setTrail(trail.slice(0, -1))}
            leading={<ChevronLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
            title={folder.title ?? folder.name}
            controlProps={{ "aria-label": t`Back from ${folder.title ?? folder.name}` }}
          />
        </li>
      ) : null}
      {tree.children(folder?.id ?? null).map((node) => (
        <li key={node.id}>
          <ListRow
            density="menu"
            current={node.documentId !== undefined && node.documentId === current}
            onOpen={() =>
              node.folder ? setTrail([...trail, node]) : onPick(node.documentId ?? node.id)
            }
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
  );
}
