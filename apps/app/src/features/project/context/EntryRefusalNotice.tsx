/**
 * A refused create, move, rename or delete said in words, with its repair beside it. The Editor tree marks
 * a row with an icon and leaves the words to the identity bar; a surface with neither hover nor an
 * identity bar (the phone's file list and document screen) says both here, on the thing the writer
 * did, so a refusal never has to be found.
 */
import { Trans } from "@lingui/react/macro";
import { Button } from "@/components/ui/button";
import type { NamespaceFailure } from "@/core/project-tree/tree-view";
import { cn } from "@/lib/utils";
import type { EntryAction } from "./ContextEntryActions";
import { NamespaceFailureMark } from "./NamespaceFailureMark";

const REPAIRS = ["move", "rename", "dismiss"] as const;

export function EntryRefusalNotice({
  failure,
  folder = false,
  move = false,
  reason,
  actions,
  onAction,
  className,
}: {
  failure: NamespaceFailure;
  folder?: boolean;
  move?: boolean;
  /** The server's reason, in its words. */
  reason?: string;
  /** What the entry allows; a refused delete has no repair here, only the row's own Delete. */
  actions: readonly EntryAction[];
  onAction: (action: EntryAction) => void;
  className?: string;
}) {
  const repairs = REPAIRS.filter(
    (action) => actions.includes(action) && !(failure === "delete" && action !== "dismiss"),
  );
  return (
    <div className={cn("flex min-w-0 flex-col items-start gap-0.5 py-1", className)}>
      <NamespaceFailureMark
        failure={failure}
        folder={folder}
        move={move}
        reason={reason}
        labelled
      />
      {repairs.length > 0 ? (
        <div className="-ml-2 flex gap-1">
          {repairs.map((action) => (
            <Button
              key={action}
              type="button"
              variant="quiet"
              size="meta"
              className="min-h-11 px-3"
              // A repair button sits inside a row that opens or toggles on a tap and on Enter.
              onClick={(event) => {
                event.stopPropagation();
                onAction(action);
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {action === "move" ? (
                <Trans>Move…</Trans>
              ) : action === "rename" ? (
                <Trans>Rename</Trans>
              ) : (
                <Trans>Dismiss</Trans>
              )}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
