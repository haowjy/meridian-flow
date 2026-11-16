import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { useThreadAgent } from "@/client/query/useAgentFiles";
import { Chip } from "@/components/ui/chip";
import { AgentFileDialog } from "./AgentFileDialog";

/**
 * Where a chat shows the Agent definition it is bound to, read-only. It offers nothing: a newer
 * save takes over when the chat compacts, so the mark only says why the chat still runs the old text.
 */
export function ThreadAgentDefinition({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  const agent = useThreadAgent(open ? threadId : null);
  return (
    <>
      <button
        type="button"
        className="self-start text-sm font-medium text-jade-text underline-offset-2 hover:underline"
        onClick={() => setOpen(true)}
      >
        <Trans>View this chat's Agent definition</Trans>
      </button>
      <AgentFileDialog
        open={open}
        onClose={() => setOpen(false)}
        title={agent.data?.name ?? t`Agent definition`}
        titleExtra={
          agent.data?.stale ? (
            <Chip kind="label" className="shrink-0">
              <Trans>A newer version is saved</Trans>
            </Chip>
          ) : null
        }
        description={t`The Agent definition this chat runs, read-only.`}
        text={{ isError: agent.isError, data: agent.data?.text }}
      />
    </>
  );
}
