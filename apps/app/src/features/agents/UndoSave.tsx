import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { RowWord } from "@/components/app/RowWord";
import { type PackageRef, packageLabel, usePackageSaves } from "./package-save";

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
  const state = saves.undoOf(saveId);
  const label = packageLabel(pkg);
  if (state === "undone" || state === "nothing")
    return (
      <RowWord
        tone="done"
        word={state === "undone" ? <Trans>Undone</Trans> : <Trans>Unchanged</Trans>}
        sentence={
          state === "undone"
            ? t`Back to the previous saved version. Your later edits are kept.`
            : t`A later Save is in use. Nothing changed.`
        }
      />
    );
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
