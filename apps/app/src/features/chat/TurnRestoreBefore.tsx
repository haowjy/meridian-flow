import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { DraftId, TurnId } from "@meridian/contracts";
import { type MouseEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Undone } from "@/features/draft-review/press-history";
import type { WorkDraftCommands } from "@/features/draft-review/usePressCommands";

/**
 * Where a draft's Restore before stands: offered, sent, done (its Undo offered), being undone, or
 * answered with nothing restored (`compacted`: the draft no longer keeps history from before the
 * turn).
 */
type RestoreState = "offered" | "restoring" | "restored" | "undoing" | "unchanged" | "compacted";

/**
 * A Draft chat turn card's `Restore before` in one draft the turn wrote: one press (`restoreTurn`),
 * with its Ctrl+Z step in each editor on its documents and its step on the sidebar's stack. Once
 * it lands the slot offers its Undo, and goes back to offering the press when any of those takes
 * it back. Its width holds still through every state, as the card's Undo does.
 */
export function RestoreBeforeSlot({
  commands,
  turn,
  draft,
  documents,
  name,
  onPressed,
}: {
  commands: WorkDraftCommands;
  turn: TurnId;
  draft: DraftId;
  /** The documents the turn wrote in this draft. */
  documents: readonly string[];
  /** The draft's name, when the card names several. */
  name: string | null;
  onPressed: () => void;
}) {
  const [state, setState] = useState<RestoreState>("offered");
  const undo = useRef<(() => Promise<unknown>) | null>(null);
  const restore = () => {
    setState("restoring");
    onPressed();
    const start = commands.restoreTurn(turn, draft, documents, () => {
      undo.current = null;
      setState("offered");
    });
    void start.outcome.then((outcome) => {
      if (outcome.kind === "done") {
        undo.current = outcome.undo ?? null;
        setState("restored");
      } else if (outcome.kind === "settled")
        setState(outcome.compacted ? "compacted" : "unchanged");
      else setState("offered");
    });
  };
  const takeBack = async () => {
    const pending = undo.current;
    if (!pending) return;
    setState("undoing");
    const undone = (await pending()) as Undone;
    // A landed Undo ends the press, which puts the offer back; a failed one leaves it restored.
    if (undone.kind === "failed") setState("restored");
  };
  const fenced = (act: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    act();
  };
  return (
    <span className="flex min-w-[6.5rem] shrink-0 items-center justify-end" data-restore-before>
      {state === "offered" || state === "restoring" ? (
        <Button
          type="button"
          variant="quiet"
          size="meta"
          disabled={state === "restoring"}
          aria-label={
            name ? t`Restore ${name} to before this turn` : t`Restore the draft to before this turn`
          }
          title={t`Put the draft back as it read before this turn`}
          onClick={fenced(restore)}
        >
          {state === "restoring" ? t`Restoring…` : t`Restore before`}
        </Button>
      ) : state === "restored" || state === "undoing" ? (
        <Button
          type="button"
          variant="quiet"
          size="meta"
          disabled={state === "undoing"}
          onClick={fenced(() => void takeBack())}
        >
          {state === "undoing" ? t`Undoing…` : t`Undo restore`}
        </Button>
      ) : (
        <span className="text-muted-foreground" role="status">
          {state === "compacted" ? (
            <Trans>Too old to restore</Trans>
          ) : (
            <Trans>Nothing to restore</Trans>
          )}
        </span>
      )}
    </span>
  );
}
