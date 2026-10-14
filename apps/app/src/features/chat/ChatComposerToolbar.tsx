/** App-specific composition of Agent, write-mode, and Work toolbar descriptors. */
import type { AiWriteMode, Work } from "@meridian/contracts/works";
import { ComposerToolbar, createComposerToolbarModel } from "@/components/app/composer-toolbar";
import { useWriteModeToolbarControl } from "@/components/app/work-composer-controls";
import { useComposerAgentToolbarControl } from "@/features/agents/ComposerAgentControl";
import { useComposerWorkToolbarControl } from "./ComposerWorkControl";

export function ChatComposerToolbar({
  projectId,
  threadId,
  work,
  agentName,
  writeMode,
  onWriteModeChange,
}: {
  projectId: string;
  threadId: string;
  work: Work;
  agentName: string;
  /** This chat's mode, with queued and local switches laid over the server's. */
  writeMode: AiWriteMode;
  onWriteModeChange(mode: AiWriteMode): void;
}) {
  const agent = useComposerAgentToolbarControl({ mode: "readonly", name: agentName });
  const writeModeControl = useWriteModeToolbarControl({
    projectId,
    workId: work.id,
    value: writeMode,
    onChoose: onWriteModeChange,
  });
  const workControl = useComposerWorkToolbarControl({ projectId, threadId, work });
  const model = createComposerToolbarModel([agent, writeModeControl, workControl]);
  return <ComposerToolbar ariaLabel="Composer controls" model={model} />;
}
