/** App-specific composition of Agent, write-mode, Work and chat-draft toolbar descriptors. */
import type { AiWriteMode, Work } from "@meridian/contracts/works";
import { ComposerToolbar, createComposerToolbarModel } from "@/components/app/composer-toolbar";
import { useWriteModeToolbarControl } from "@/components/app/work-composer-controls";
import {
  type ComposerAgentControlProps,
  useComposerAgentToolbarControl,
} from "@/features/agents/ComposerAgentControl";
import { useChatDraftToolbarControl } from "./ChatDraftControl";
import { useComposerWorkToolbarControl } from "./ComposerWorkControl";

export function ChatComposerToolbar({
  projectId,
  threadId,
  work,
  agent: agentProps,
  writeMode,
  onWriteModeChange,
}: {
  projectId: string;
  threadId: string;
  work: Work;
  agent: ComposerAgentControlProps;
  /** This chat's mode, with queued and local switches laid over the server's. */
  writeMode: AiWriteMode;
  onWriteModeChange(mode: AiWriteMode): void;
}) {
  const agent = useComposerAgentToolbarControl(agentProps);
  const writeModeControl = useWriteModeToolbarControl({
    value: writeMode,
    onChoose: onWriteModeChange,
  });
  const workControl = useComposerWorkToolbarControl({ projectId, threadId, work });
  const draftControl = useChatDraftToolbarControl({ projectId, threadId, work, writeMode });
  const model = createComposerToolbarModel(
    draftControl
      ? [agent, writeModeControl, workControl, draftControl]
      : [agent, writeModeControl, workControl],
  );
  return <ComposerToolbar ariaLabel="Composer controls" model={model} />;
}
