/** App-specific composition of Agent, write-mode, and Work toolbar descriptors. */
import type { Work } from "@meridian/contracts/works";
import { ComposerToolbar, createComposerToolbarModel } from "@/components/app/composer-toolbar";
import { useSelectedWorkWriteModeToolbarControl } from "@/components/app/work-composer-controls";
import { useComposerAgentToolbarControl } from "@/features/agents/ComposerAgentControl";
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
  const writeMode = useSelectedWorkWriteModeToolbarControl({
    projectId,
    work,
  });
  const workControl = useComposerWorkToolbarControl({ projectId, threadId, work });
  const model = createComposerToolbarModel([agent, writeMode, workControl]);
  return <ComposerToolbar ariaLabel="Composer controls" model={model} />;
}
