import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { DraftId, TurnId } from "@meridian/contracts";
import { type MouseEvent, useEffect, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { WorkDraftCommands } from "@/features/draft-review/usePressCommands";

/**
 * A Draft chat turn card's `Undo turn` in one draft the turn wrote, then `Undone` with its Undo:
 * one press, whose state is the owner's (`DraftCommandOwner.restore`), so the card, every editor's Ctrl+Z and the
 * sidebar show one press with one Undo, and a reload or another tab shows the same once the
 * card's read names it (`named`). Its width holds still through every state.
 */
export function UndoTurnSlot({
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
    <span className="flex min-w-[7.5rem] shrink-0 items-center justify-end" data-undo-turn>
      {entry?.kind === "in-force" ? (
        <>
          <span className="text-muted-foreground" role="status">
            <Trans>Undone</Trans>
          </span>
          <Button
            type="button"
            variant="quiet"
            size="meta"
            disabled={entry.press.undoing}
            aria-label={name ? t`Undo in ${name}` : undefined}
            onClick={fenced(() => commands.undoRestore(turn, draft))}
            className="text-jade-text"
          >
            {t`Undo`}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="quiet"
          size="meta"
          disabled={entry?.kind === "sending"}
          aria-label={name ? t`Undo turn in ${name}` : undefined}
          title={
            name
              ? t`Take back what this turn wrote in ${name}`
              : t`Take back what this turn wrote in the draft`
          }
          onClick={fenced(() => commands.restoreTurn(turn, draft, documents))}
          className="text-jade-text"
        >
          {entry?.kind === "sending" ? t`Undoing…` : t`Undo turn`}
        </Button>
      )}
    </span>
  );
}
