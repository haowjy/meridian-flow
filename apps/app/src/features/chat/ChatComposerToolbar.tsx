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
  agentSlug,
  readonlyAgent,
  onAgentChange,
}: {
  projectId: string;
  threadId: string;
  work: Work;
  agentSlug: string;
  readonlyAgent: boolean;
  onAgentChange(slug: string): void;
}) {
  const agent = useComposerAgentToolbarControl(
    readonlyAgent
      ? { projectId, mode: "readonly", selectedSlug: agentSlug }
      : {
          projectId,
          mode: "interactive",
          selectedSlug: agentSlug,
          onSelectedSlugChange: onAgentChange,
        },
  );
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

export function AgentOnlyComposerToolbar({
  projectId,
  agentSlug,
  readonlyAgent = false,
  onAgentChange,
}: {
  projectId: string | null;
  agentSlug: string;
  readonlyAgent?: boolean;
  onAgentChange?(slug: string): void;
}) {
  const agent = useComposerAgentToolbarControl(
    readonlyAgent
      ? { projectId, mode: "readonly", selectedSlug: agentSlug }
      : {
          projectId,
          mode: "interactive",
          selectedSlug: agentSlug,
          onSelectedSlugChange: onAgentChange ?? (() => {}),
        },
  );
  return (
    <ComposerToolbar ariaLabel="Composer controls" model={createComposerToolbarModel([agent])} />
  );
}
