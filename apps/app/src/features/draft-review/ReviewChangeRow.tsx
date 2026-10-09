/**
 * ReviewChangeRow — one change as one line: a dot in its colour, a short
 * excerpt, who made it, and Discard and Apply as icon buttons. Clicking the row
 * focuses the change in the manuscript.
 *
 * Presentational: the document's change list (the desktop popover and the
 * phone's sheet) and the Work page's expanded files both render it, and none
 * passes a controller. The row never decides what Apply or Discard means; it
 * calls what it is given.
 *
 * `touch` is the phone's row: the same line with every control a 44px target.
 *
 * The excerpt keeps a readable share of the line. The author sits beside it
 * when its names fit and wraps under it otherwise (flex-wrap decides, no
 * measuring), so several chats never squeeze the excerpt down to a letter.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Check, X } from "lucide-react";

import type { ChangeCommandState } from "@/client/query/draft-command-record";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { ChangeAuthor, ChangeDot, ChangeFailureText, discardLabel } from "./ReviewChangeParts";
import { changeExcerpt, type ReviewChange } from "./review-changes";

export type ReviewChangeRowProps = {
  change: ReviewChange;
  focused: boolean;
  /** This change just arrived while the writer was reviewing; it pulses once. */
  arrived?: boolean;
  /** Disposition is locked (a command is in flight, or the Work is archived). */
  disabled: boolean;
  /** Per-change Apply is unavailable for a new document: it is applied whole. */
  canApply: boolean;
  /** Why the last command on this change did not land. */
  failure: Extract<ChangeCommandState, { phase: "failed" }> | null;
  onFocus: () => void;
  onApply: () => void;
  onDiscard: () => void;
  touch?: boolean;
};

export function ReviewChangeRow({
  change,
  focused,
  arrived = false,
  disabled,
  canApply,
  failure,
  onFocus,
  onApply,
  onDiscard,
  touch = false,
}: ReviewChangeRowProps) {
  const { added, removed } = changeExcerpt(change);
  // The first line's height: the excerpt, the dot and the buttons share it, so
  // they stay centred on each other when the author wraps to a second line.
  const firstLine = touch ? "min-h-11" : change.actionable ? "min-h-6" : undefined;
  const iconButton = touch ? "size-11 [&_svg:not([class*='size-'])]:size-5" : undefined;
  return (
    // Mouse convenience only: the keyboard reaches the same command through
    // the excerpt button, which is the row's one tab stop for focusing it.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above.
    <li
      data-review-change-row={change.classId}
      data-focused={focused ? "true" : undefined}
      data-arrived={arrived ? "true" : undefined}
      onClick={onFocus}
      className={cn(
        "group flex cursor-pointer flex-col gap-0.5 rounded-md border border-transparent px-2 py-1 transition-colors",
        focused ? "border-border-subtle bg-card" : "hover:bg-sidebar-accent/50",
        arrived && "meridian-review-row-arrived",
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        {/* The dot sits outside the excerpt button so an author wrapped under
            the excerpt lines up with the excerpt text, not with the dot. */}
        <span className={cn("flex items-center", firstLine)}>
          <ChangeDot change={change} />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
          <button
            type="button"
            aria-current={focused ? "true" : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onFocus();
            }}
            className={cn(
              "focus-ring flex min-w-0 flex-[1_1_8rem] items-center rounded-sm text-left text-caption",
              firstLine,
              touch && "text-sm",
            )}
          >
            <span className="min-w-0 flex-1 truncate">
              {removed && !added ? (
                <span className="text-muted-foreground line-through">{removed}</span>
              ) : (
                <>
                  {removed ? (
                    <span className="mr-1 text-muted-foreground line-through">{removed}</span>
                  ) : null}
                  <span>{added ?? <Trans>Edited</Trans>}</span>
                </>
              )}
            </span>
          </button>
          <ChangeAuthor
            attribution={change.attribution}
            className={cn("max-w-full", touch && "inline-flex min-h-11 items-center")}
          />
        </div>
        {change.actionable ? (
          <span className="flex shrink-0 items-center">
            <IconButton
              size="xs"
              tooltip={discardLabel(change)}
              disabled={disabled}
              className={iconButton}
              onClick={(event) => {
                event.stopPropagation();
                onDiscard();
              }}
            >
              <X aria-hidden />
            </IconButton>
            {canApply ? (
              <IconButton
                size="xs"
                tooltip={t`Apply`}
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onApply();
                }}
                className={cn("text-primary hover:text-primary", iconButton)}
              >
                <Check aria-hidden />
              </IconButton>
            ) : null}
          </span>
        ) : null}
      </div>
      {failure ? (
        <p role="status" className="pl-4 text-caption text-destructive">
          <ChangeFailureText failure={failure} />
        </p>
      ) : null}
    </li>
  );
}
