/**
 * The compact menu a drop across systems asks with, hung at the pointer where
 * the writer let go: the items the list derived, then Cancel. No heading; the
 * labels name the destination. Escape, Cancel and a click outside all close it
 * with nothing changed, and focus goes back to the list.
 */
import { t } from "@lingui/core/macro";
import { Fragment } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { pointerAnchorStyle } from "@/features/editor/chrome";
import type { DropAction, DropChoiceItem, PendingChoice } from "./drop-choice";

/** What a list shows while a drop waits for its choice. */
export type DropChoiceState = Pick<PendingChoice, "point" | "returnFocus"> & {
  items: readonly DropChoiceItem[];
  choose: (action: DropAction) => void;
  dismiss: () => void;
};

export function DropChoiceMenu({ point, items, returnFocus, choose, dismiss }: DropChoiceState) {
  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      {/* Radix DropdownMenu has no standalone anchor; this inert trigger holds the pointer's place. */}
      <DropdownMenuTrigger aria-hidden tabIndex={-1} style={pointerAnchorStyle(point)} />
      <DropdownMenuContent
        align="start"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        {items.map((item) => (
          <Fragment key={item.action}>
            <DropdownMenuItem disabled={!item.enabled} onSelect={() => choose(item.action)}>
              {item.label}
            </DropdownMenuItem>
            {item.reason ? (
              <p className="px-2 pb-1 text-xs text-muted-foreground">{item.reason}</p>
            ) : null}
          </Fragment>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem>{t`Cancel`}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
