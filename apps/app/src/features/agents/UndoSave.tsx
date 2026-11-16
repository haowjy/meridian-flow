import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useAgentFiles } from "@/client/query/useAgentFiles";
import { RowWord } from "@/components/app/RowWord";
import { type PackageRef, packageLabel, statusOf, usePackageSaves } from "./package-save";

export function UndoSave({
  projectId,
  pkg,
  saveId,
}: {
  projectId: string;
  pkg: PackageRef;
  saveId: string;
}) {
  const saves = usePackageSaves(projectId);
  const status = statusOf(useAgentFiles(projectId)?.packages, pkg);
  const state = saves.undoOf(saveId);
  const label = packageLabel(pkg);
  if (!status) return null;
  if (status.undoable?.saveId !== saveId) {
    if (status.saveId === saveId) return null;
    const undone = status.undoneSaveIds.includes(saveId);
    return (
      <RowWord
        tone="done"
        word={undone ? <Trans>Undone</Trans> : <Trans>Unchanged</Trans>}
        sentence={
          undone
            ? t`Back to the previous saved version. Your later edits are kept.`
            : t`A later Save is in use. Nothing changed.`
        }
      />
    );
  }
  return (
    <RowWord
      tone={state === "failed" ? "warning" : "action"}
      word={<Trans>Undo</Trans>}
      label={t`Undo save of ${label}`}
      sentence={
        state === "failed"
          ? t`Couldn't reach the server. Undo tries again.`
          : t`Undo goes back to the previous saved version and merges its text into your files. An edit made since is kept, and where you changed the same text yours stays.`
      }
      pending={state === "pending"}
      onAction={() => void saves.undo(pkg, saveId)}
    />
  );
}
