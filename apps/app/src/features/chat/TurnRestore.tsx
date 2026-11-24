import { t } from "@lingui/core/macro";
import type { DraftId, TurnId } from "@meridian/contracts";
import { useEffect, useSyncExternalStore } from "react";
import type { WorkDraftCommands } from "@/features/draft-review/usePressCommands";
import { UndoCell } from "./UndoCell";

/**
 * A Draft chat turn card's restore in one draft the turn wrote, labelled `Undo turn`, then
 * `Undone` with its Undo: one press, whose state is the owner's (`DraftCommandOwner.restore`), so
 * the card, every editor's Ctrl+Z and the sidebar show one press with one Undo, and a reload or
 * another tab shows the same once the card's read names it (`named`).
 */
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
  /** The documents the turn wrote in this draft. */
  documents: readonly string[];
  /** The draft's name, when the card names several. */
  name: string | null;
  /** The card's read says pressing it would change something. */
  offered: boolean;
  /** The press in force the card's read names: an id, or none; undefined before the card has a read. */
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
