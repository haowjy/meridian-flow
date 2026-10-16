/** A change's excerpt, attribution and commands on one line. The excerpt truncates first; touch controls retain 44px targets. Failures stay inline. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Check, X } from "lucide-react";

import type { ChangeFailure, DraftCommandFailure } from "@/client/query/draft-command-record";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { ChangeAuthor, ChangeDot, ChangeFailureText, discardLabel } from "./ReviewChangeParts";
import { ReviewMessageText } from "./ReviewMessageText";
import { changeExcerpt, type ReviewChange } from "./review-model";

export type ReviewChangeRowProps = {
  change: ReviewChange;
  focused: boolean;
  /** This change just arrived while the writer was reviewing; it pulses once. */
  arrived?: boolean;
  /** Disposition is locked (a command is in flight, or the Work is archived). */
  disabled: boolean;

  /** Why the last command on this change did not land. */
  failure: ChangeFailure | null;
  draftFailure?: DraftCommandFailure | null;
  onFocus: () => void;
  onApply: () => void;
  onDiscard: () => void;
  touch?: boolean;
  showAttribution?: boolean;
  wholeDocument?: boolean;
  documentName?: string;
};

export function ReviewChangeRow({
  change,
  focused,
  arrived = false,
  disabled,

  failure,
  draftFailure,
  onFocus,
  onApply,
  onDiscard,
  touch = false,
  showAttribution = false,
  wholeDocument = false,
  documentName,
}: ReviewChangeRowProps) {
  const runs = documentName
    ? [{ kind: "added" as const, text: documentName }]
    : changeExcerpt(change);
  // The first line's height: the excerpt, the dot and the buttons share it, so
  // they stay centred on each other when the author wraps to a second line.
  const firstLine = touch ? "min-h-11" : "min-h-6";
  const iconButton = touch ? "size-11 [&_svg:not([class*='size-'])]:size-5" : undefined;
  return (
    // Mouse convenience only: the keyboard reaches the same command through
    // the excerpt button, which is the row's one tab stop for focusing it.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see above.
    <li
      data-review-change-row={change.id}
      data-focused={focused ? "true" : undefined}
      data-arrived={arrived ? "true" : undefined}
      onClick={onFocus}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1 transition-colors",
        focused ? "border-border-subtle bg-card" : "hover:bg-sidebar-accent/50",
        arrived && "meridian-review-row-arrived",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* The dot sits outside the excerpt button so an author wrapped under
            the excerpt lines up with the excerpt text, not with the dot. */}
        {wholeDocument ? null : (
          <span className={cn("flex items-center", firstLine)}>
            <ChangeDot change={change} />
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-x-2">
          <button
            type="button"
            aria-current={focused ? "true" : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onFocus();
            }}
            className={cn(
              "focus-ring flex min-w-0 flex-1 items-center rounded-sm text-left text-caption",
              firstLine,
              touch && "text-sm",
            )}
          >
            <span className="min-w-0 flex-1 truncate">
              {runs.length ? (
                runs.map((run, index) => (
                  <span
                    // Runs retain document order, including repeated identical words.
                    key={index}
                    className={cn(
                      index < runs.length - 1 && "mr-1",
                      !documentName &&
                        (run.kind === "removed"
                          ? "text-diff-removed line-through"
                          : "text-diff-added"),
                    )}
                  >
                    {run.text}
                  </span>
                ))
              ) : (
                <Trans>Edited</Trans>
              )}
            </span>
          </button>
          {showAttribution ? (
            <ChangeAuthor overflow="hide" change={change} className="shrink-0" />
          ) : null}
        </div>
        <span className="flex shrink-0 items-center">
          <IconButton
            size="xs"
            tooltip={discardLabel()}
            disabled={disabled}
            className={iconButton}
            onClick={(event) => {
              event.stopPropagation();
              onDiscard();
            }}
          >
            <X aria-hidden />
          </IconButton>
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
        </span>
      </div>
      {failure || draftFailure ? (
        <p role="status" className="min-w-0 max-w-[50%] text-caption text-destructive">
          {draftFailure ? (
            <ReviewMessageText failure={draftFailure} />
          ) : failure ? (
            <ChangeFailureText failure={failure} />
          ) : null}
        </p>
      ) : null}
    </li>
  );
}
