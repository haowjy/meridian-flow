import { t } from "@lingui/core/macro";
import type { DraftId, TurnId } from "@meridian/contracts";
import { useEffect, useSyncExternalStore } from "react";
import type { WorkDraftCommands } from "@/features/draft-review/usePressCommands";
import { UndoCell } from "./UndoCell";

export function TurnRestoreSlot({
  commands,
  turn,
  draft,
  documents,
  name,
  offered,
  named,
  readAt,
}: {
  commands: WorkDraftCommands;
  turn: TurnId;
  draft: DraftId;
  documents: readonly string[];
  name: string | null;
  offered: boolean;
  named: string | null | undefined;
  readAt: number;
}) {
  const { owner } = commands;
  useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  useEffect(
    () => commands.syncRestore(turn, draft, named, readAt),
    [commands, turn, draft, named, readAt],
  );
  const entry = owner.restore(turn, draft);
  if (!entry && !offered) return null;
  const inForce = entry?.kind === "in-force" ? entry : null;
  return (
    <UndoCell
      offer={{
        label: t`Undo turn`,
        ...(name ? { ariaLabel: t`Undo turn in ${name}` } : {}),
        pending: entry?.kind === "sending",
        onPress: () => commands.restoreTurn(turn, draft, documents),
      }}
      undone={inForce !== null}
      undoUndone={
        inForce
          ? {
              ...(name ? { ariaLabel: t`Undo in ${name}` } : {}),
              pending: inForce.press.undoing,
              onPress: () => commands.undoRestore(turn, draft),
            }
          : undefined
      }
    />
  );
}
