import { t } from "@lingui/core/macro";
import type { AgentFileStatus } from "@meridian/contracts/agents";
import { useBuiltinAgentFile } from "@/client/query/useAgentFiles";
import { AgentFileDialog } from "./AgentFileDialog";
import { AgentFileStatusNotice } from "./AgentFileNotice";

/**
 * A built-in Agent or skill opens here, read-only: it is no document, so it has no main address,
 * as a chat's upload has none.
 */
export function BuiltinAgentFileDialog({
  file,
  onClose,
}: {
  file: AgentFileStatus | null;
  onClose: () => void;
}) {
  const text = useBuiltinAgentFile(file?.path ?? null);
  return (
    <AgentFileDialog
      open={file !== null}
      onClose={onClose}
      title={file?.slug ?? ""}
      description={
        file?.kind === "skill" ? t`Built-in skill, read-only` : t`Built-in Agent, read-only`
      }
      notice={file ? <AgentFileStatusNotice file={file} className="mx-4 mt-3" /> : null}
      text={text}
    />
  );
}
