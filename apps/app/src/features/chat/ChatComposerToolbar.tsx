/** App-specific composition of Agent, write-mode, and Work toolbar descriptors. */
import type { Work } from "@meridian/contracts/works";
import { ComposerToolbar, createComposerToolbarModel } from "@/components/app/composer-toolbar";
import { useSelectedWorkWriteModeToolbarControl } from "@/components/app/work-composer-controls";
import { useComposerAgentToolbarControl } from "@/features/agents/ComposerAgentControl";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";
import { useComposerWorkToolbarControl } from "./ComposerWorkControl";

export function ChatComposerToolbar({
  projectId,
  threadId,
  work,
  agentName,
}: {
  projectId: string;
  threadId: string;
  work: Work;
  agentName: string;
}) {
  const agent = useComposerAgentToolbarControl({ mode: "readonly", name: agentName });
  const { openAiDraft } = useAiDraftLauncher();
  const writeMode = useSelectedWorkWriteModeToolbarControl({
    projectId,
    work,
    openDraftReview: (group, draftId) => {
      if (!group.contextPath) return;
      openAiDraft({ ...group, workId: work.id, draftId, contextPath: group.contextPath });
    },
  });
  const workControl = useComposerWorkToolbarControl({ projectId, threadId, work });
  const model = createComposerToolbarModel([agent, writeMode, workControl]);
  return <ComposerToolbar ariaLabel="Composer controls" model={model} />;
}
