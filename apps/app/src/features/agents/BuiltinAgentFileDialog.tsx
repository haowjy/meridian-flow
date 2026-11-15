import { t } from "@lingui/core/macro";
import type { AgentFileStatus } from "@meridian/contracts/agents";
import { useState } from "react";
import { useBuiltinAgentFile } from "@/client/query/useAgentFiles";
import { AgentFileDialog } from "./AgentFileDialog";
import { AgentFileStatusNotice } from "./AgentFileState";

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
  // The dialog fades out after `file` clears; it keeps showing the last file until it is gone.
  const [shown, setShown] = useState(file);
  if (file && file !== shown) setShown(file);
  const text = useBuiltinAgentFile(shown?.path ?? null);
  return (
    <AgentFileDialog
      open={file !== null}
      onClose={onClose}
      title={shown?.slug ?? ""}
      description={
        shown?.kind === "skill" ? t`Built-in skill, read-only` : t`Built-in Agent, read-only`
      }
      notice={shown ? <AgentFileStatusNotice file={shown} className="mx-4 mt-3" /> : null}
      text={text}
    />
  );
}
