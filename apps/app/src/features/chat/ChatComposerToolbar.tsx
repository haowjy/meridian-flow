import type { AiWriteMode, Work } from "@meridian/contracts/works";
import {
  type ComposerAgentControlProps,
  useComposerAgentToolbarControl,
} from "@/features/agents/ComposerAgentControl";
import { ComposerToolbar, createComposerToolbarModel } from "@/features/chat/composer/toolbar";
import { useWriteModeToolbarControl } from "@/features/chat/composer/work-controls";
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
