import { t } from "@lingui/core/macro";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useWorkDrafts } from "@/client/query/draft-commands";
import { useDisplayedThread } from "@/client/query/useDisplayedThread";
import { workDraftName } from "@/features/draft-review/draft-names";
import { usePressCommands, type WorkDraftCommands } from "@/features/draft-review/usePressCommands";
import { useProjectDocumentNavigationProjectId } from "@/features/project/context/open-project-document";

type TurnCardDrafts = { commands: WorkDraftCommands; nameOf: (draft: string) => string };

const TurnCardDraftsContext = createContext<TurnCardDrafts | null>(null);

export function TurnCardDraftsProvider({
  threadId,
  children,
}: {
  threadId: string;
  children: ReactNode;
}) {
  const projectId = useProjectDocumentNavigationProjectId();
  const thread = useDisplayedThread(projectId ?? "", threadId);
  const drafts = useWorkDrafts(projectId ?? "", thread?.workId ?? null).drafts;
  const commands = usePressCommands({
    projectId: projectId ?? "",
    work: null,
    drafts: drafts?.map((draft) => draft.id) ?? [],
    threadId,
    surface: "strip",
  });
  const value = useMemo(
    () => ({
      commands,
      nameOf: (draft: string) => {
        const found = drafts?.find((each) => each.id === draft);
        return found ? workDraftName(found) : t`Draft`;
      },
    }),
    [commands, drafts],
  );
  return (
    <TurnCardDraftsContext.Provider value={projectId ? value : null}>
      {children}
    </TurnCardDraftsContext.Provider>
  );
}

export function useTurnCardDrafts(): TurnCardDrafts | null {
  return useContext(TurnCardDraftsContext);
}
