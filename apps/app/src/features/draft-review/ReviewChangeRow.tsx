/**
 * A change's excerpt, attribution and commands on one line; touch controls retain 44px targets. Failures are the
 * file's, shown once in its reserved status line (`DraftCommandStatus`), never under a row.
 * The red and green text claims its width first: when the line is full the byline truncates before it, but only down
 * to its floor ("You", a few letters of the first chat, "+N"), and then the excerpt truncates.
 */
import { Trans } from "@lingui/react/macro";
import { cn } from "@/lib/utils";
import { ReviewActions } from "./ReviewActions";
import { ChangeAuthor, ChangeDot } from "./ReviewChangeParts";
import { changeExcerpt, type ReviewChange } from "./review-model";
import { treeLineSentence } from "./tree-line";

export type ReviewChangeRowProps = {
  change: ReviewChange;
  focused: boolean;
  /** This change just arrived while the writer was reviewing; it pulses once. */
  arrived?: boolean;
  /** Disposition is locked (a command is in flight, or the Work is archived). */
  disabled: boolean;
  canApply?: boolean;
  onFocus: () => void;
  onApply: () => void;
  onDiscard: () => void;
  /** The Discard can't run here, so it carries no Undo and asks first. */
  discardAsks: boolean;
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
  canApply = true,
  onFocus,
  onApply,
  onDiscard,
  discardAsks,
  touch = false,
  showAttribution = false,
  wholeDocument = false,
  documentName,
}: ReviewChangeRowProps) {
  // A move or delete says what it does to the file, in the row's ink rather than diff colours.
  const sentence = change.tree ? treeLineSentence(change.tree) : documentName;
  const runs = sentence ? [{ kind: "added" as const, text: sentence }] : changeExcerpt(change);
  // The first line's height: the excerpt, the dot and the buttons share it, so
  // they stay centred on each other when the author wraps to a second line.
  const firstLine = touch ? "min-h-11" : "min-h-6";
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
        "group flex cursor-pointer items-center rounded-md border border-transparent px-2 py-1 transition-colors",
        focused ? "border-border-subtle bg-card" : "hover:bg-ink-fill",
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
        {/* Two tracks: the excerpt grows to its full width before the byline takes the rest, and the
            byline's track never drops below its floor (the byline's own min-width). */}
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,max-content)_minmax(auto,1fr)] items-center gap-x-2">
          <button
            type="button"
            aria-current={focused ? "true" : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onFocus();
            }}
            className={cn(
              "focus-ring flex min-w-0 items-center rounded-sm text-left text-xs",
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
                      !sentence &&
                        (run.kind === "removed"
                          ? "text-destructive line-through"
                          : "text-jade-text"),
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
            <ChangeAuthor fit="first" change={change} touch={touch} className="justify-end" />
          ) : null}
        </div>
        {!disabled ? (
          <ReviewActions
            scope="change"
            density="icon"
            touch={touch}
            className={touch ? undefined : "gap-0.5"}
            discardAsks={discardAsks}
            onDiscard={onDiscard}
            onApply={
              canApply
                ? (event) => {
                    event.stopPropagation();
                    onApply();
                  }
                : undefined
            }
          />
        ) : null}
      </div>
    </li>
  );
}
