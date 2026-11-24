import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { MouseEvent } from "react";
import { Button } from "@/components/ui/button";

type CellAction = { label: string; ariaLabel?: string; pending: boolean; onPress: () => void };

export function UndoCell({
  offer,
  undone,
  undoUndone,
}: {
  offer: CellAction | null;
  undone: boolean;
  undoUndone?: Omit<CellAction, "label">;
}) {
  const fenced = (act: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    act();
  };
  const button = (action: CellAction) => (
    <Button
      type="button"
      variant="quiet"
      size="meta"
      disabled={action.pending}
      aria-label={action.ariaLabel}
      onClick={fenced(action.onPress)}
      className="text-jade-text"
    >
      {action.pending ? t`Undoing…` : action.label}
    </Button>
  );
  return (
    <span className="ml-auto flex min-w-[7.5rem] shrink-0 items-center justify-end">
      {undone ? (
        <>
          <span className="text-muted-foreground" role="status">
            <Trans>Undone</Trans>
          </span>
          {undoUndone ? button({ ...undoUndone, label: t`Undo` }) : null}
        </>
      ) : offer ? (
        button(offer)
      ) : null}
    </span>
  );
}
