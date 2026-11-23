import { t } from "@lingui/core/macro";
import type { DraftId, TurnId } from "@meridian/contracts";
import { type MouseEvent, useEffect, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { WorkDraftCommands } from "@/features/draft-review/usePressCommands";

/**
 * A Draft chat turn card's `Restore before` in one draft the turn wrote: one press, whose state
 * is the owner's (`DraftCommandOwner.restore`), so the card, every editor's Ctrl+Z and the
 * sidebar show one press with one Undo, and a reload or another tab shows the same once the
 * card's read names it (`named`). Its width holds still through every state.
 */
export function RestoreBeforeSlot({
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
  /** The press in force the card's read names: an id, none, or undefined where it doesn't say. */
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
  const fenced = (act: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    act();
  };
  return (
    <span className="flex min-w-[6.5rem] shrink-0 items-center justify-end" data-restore-before>
      {entry?.kind === "in-force" ? (
        <Button
          type="button"
          variant="quiet"
          size="meta"
          disabled={entry.press.undoing}
          aria-label={name ? t`Undo restoring ${name}` : undefined}
          onClick={fenced(() => commands.undoRestore(turn, draft))}
        >
          {entry.press.undoing ? t`Undoing…` : t`Undo restore`}
        </Button>
      ) : (
        <Button
          type="button"
          variant="quiet"
          size="meta"
          disabled={entry?.kind === "sending"}
          aria-label={
            name ? t`Restore ${name} to before this turn` : t`Restore the draft to before this turn`
          }
          title={t`Put the draft back as it read before this turn`}
          onClick={fenced(() => commands.restoreTurn(turn, draft, documents))}
        >
          {entry?.kind === "sending" ? t`Restoring…` : t`Restore before`}
        </Button>
      )}
    </span>
  );
}
