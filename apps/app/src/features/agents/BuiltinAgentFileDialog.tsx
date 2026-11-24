import { t } from "@lingui/core/macro";
import type { AgentFileStatus } from "@meridian/contracts/agents";
import { useState } from "react";
import { useSavedAgentFile } from "@/client/query/useAgentFiles";
import { AgentFileDialog } from "./AgentFileDialog";
import { TroubleChip } from "./AgentFileState";
import { fileTrouble } from "./findings";

export function BuiltinAgentFileDialog({
  file,
  onClose,
}: {
  file: AgentFileStatus | null;
  onClose: () => void;
}) {
  const [shown, setShown] = useState(file);
  if (file && file !== shown) setShown(file);
  const text = useSavedAgentFile(
    shown ? { level: "builtin", path: shown.path, saveId: null } : null,
  );
  const trouble = shown ? fileTrouble(shown, undefined) : null;
  return (
    <AgentFileDialog
      open={file !== null}
      onClose={onClose}
      title={shown?.slug ?? ""}
      description={
        shown?.kind === "skill" ? t`Built-in skill, read-only` : t`Built-in Agent, read-only`
      }
      titleExtra={shown && trouble ? <TroubleChip file={shown} trouble={trouble} /> : null}
      text={text}
    />
  );
}
