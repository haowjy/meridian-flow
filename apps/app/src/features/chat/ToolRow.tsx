import { t } from "@lingui/core/macro";
import { isToolNotRunResult, isToolStoppedResult } from "@meridian/contracts/protocol";
import { isNotesStepHeldResult } from "@meridian/contracts/threads";
import { documentToolReturned, type ToolView } from "@meridian/thread-client";
import { Pause } from "lucide-react";
import { memo, useMemo } from "react";
import { ActivityRow, type ActivityRowStatus } from "./ActivityRow";
import { descriptorFor } from "./command-descriptor";
import { errorMessageExpand } from "./tool-failure";
import { EndedCallTitle, rendererFor, toolRowFailed } from "./tool-renderers";

export type ToolRowProps = {
  tool: ToolView;
};

function ToolRowComponent({ tool }: ToolRowProps) {
  if (isNotesStepHeldResult(tool.result)) {
    return (
      <div data-tool-call-id={tool.toolCallId ?? undefined}>
        <ActivityRow Icon={Pause} title={t`Not run before compaction`} status="done" />
      </div>
    );
  }
  return <ExecutedToolRow tool={tool} />;
}

const renderChild = (child: ToolView) => <ToolRow tool={child} />;

function ExecutedToolRow({ tool }: ToolRowProps) {
  const renderer = rendererFor(tool.toolName);
  const ended = isToolNotRunResult(tool.result) || isToolStoppedResult(tool.result);
  const status: ActivityRowStatus =
    tool.status === "partial"
      ? "running"
      : toolRowFailed(tool) && !ended && !documentToolReturned(tool)
        ? "error"
        : "done";
  const presentation = useMemo(
    () =>
      ended
        ? { title: <EndedCallTitle tool={tool} />, expand: undefined }
        : {
            title: renderer.title(tool),
            expand: renderer.expand?.(tool, renderChild) ?? errorMessageExpand(tool) ?? undefined,
          },
    [renderer, tool, ended],
  );
  return (
    <div data-tool-call-id={tool.toolCallId ?? undefined}>
      <ActivityRow
        Icon={descriptorFor(tool).Icon}
        title={presentation.title}
        status={status}
        expand={presentation.expand}
      />
    </div>
  );
}

export const ToolRow = memo(ToolRowComponent);
ToolRow.displayName = "ToolRow";
