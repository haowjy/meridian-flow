/**
 * DraftDock — the composer-attached strip for THIS chat's pending changes.
 *
 * Visual model: a jade-tinted strip that sits BEHIND the composer (narrower
 * via horizontal margin, top corners rounded) — the composer keeps its own
 * border and overlaps the strip's top edge, creating a layered look. It mounts
 * only when this chat has a pending change in its Work: a chat with no changes
 * of its own shows no strip, however many drafts the Work holds
 * (`useDraftDock`). No terminal flash, no generating state; the streaming turn
 * in the transcript is sufficient.
 *
 * First line: the file's name (or "N documents") and the count of this chat's
 * changes, which appears once every preview has landed. The notes sit under it,
 * collapsed or expanded, so the writer reads them before any click: a change
 * tied to another chat's edit, changes only Apply draft or Discard draft can
 * handle, and a new document (Review-only). Several files expand to a row per
 * file; the strip ends with "All changes in <Work>" (always for one file, once
 * expanded for several).
 *
 * Apply and Discard act on this chat's changes only, never on a whole draft.
 * Verb order follows the one draft-action grammar: the action that commits is
 * rightmost, Discard sits immediately left of it, and anything backing out
 * (Keep) is leftmost.
 *
 * All visibility derives from draft-review state (the shared previews and
 * command records, never ad hoc queries), so the strip, the editor bar and the
 * transcript can never disagree about what is pending.
 */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { DockFailureText, DockNotesText } from "./DraftDockMessages";
import { type DockFile, dockNotes, hasNotes } from "./draft-dock-files";
import type { DraftDockModel } from "./useDraftDock";

export function DraftDock({ dock }: { dock: DraftDockModel }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const troubledFileCount = dock.files.filter(
    (file) => file.status === "error" || dock.fileFailure(file) !== null,
  ).length;
  // A refusal or a preview that did not load opens the strip so the writer sees it.
  useEffect(() => {
    if (troubledFileCount > 0) setExpanded(true);
  }, [troubledFileCount]);

  if (!dock.mounted) return null;

  const multi = dock.files.length > 1;
  const only = dock.files[0];
  const notes = dockNotes(dock.files);
  const noted = hasNotes(notes);
  const confirming = confirmingDiscard && dock.showCommands;
  const footer =
    dock.openWorkChanges && dock.workName && (!multi || expanded) ? (
      <button
        type="button"
        onClick={dock.openWorkChanges}
        className="focus-ring flex min-h-7 w-full items-center gap-[var(--chat-space-inline)] border-border-subtle border-t px-[var(--chat-card-pad-x)] text-left text-caption text-ink-muted hover:text-foreground [@media(pointer:coarse)]:min-h-11"
      >
        <ChevronRight className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          <Trans>All changes in {dock.workName}</Trans>
        </span>
      </button>
    ) : null;

  const commands = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: pure click fence so verb buttons don't also toggle the row.
    // biome-ignore lint/a11y/noStaticElementInteractions: same — stopPropagation fence only, no interaction of its own.
    <div
      className="flex shrink-0 flex-wrap items-center justify-end gap-[var(--chat-space-inline)]"
      onClick={(event) => event.stopPropagation()}
    >
      {confirming ? (
        <>
          <span className="whitespace-nowrap text-ink-muted">
            <Trans>Discard this chat's changes?</Trans>
          </span>
          <QuietButton onClick={() => setConfirmingDiscard(false)}>
            <Trans>Keep</Trans>
          </QuietButton>
          <QuietButton
            onClick={() => {
              setConfirmingDiscard(false);
              dock.discard();
            }}
            disabled={!dock.canCommand}
          >
            <Trans>Discard</Trans>
          </QuietButton>
        </>
      ) : (
        <>
          {dock.showCommands ? (
            <>
              <QuietButton
                onClick={() => (multi ? setConfirmingDiscard(true) : dock.discard())}
                disabled={!dock.canCommand}
              >
                <Trans>Discard</Trans>
              </QuietButton>
              <QuietButton onClick={dock.apply} disabled={!dock.canCommand}>
                <Trans>Apply</Trans>
              </QuietButton>
            </>
          ) : null}
          <ReviewPill onClick={dock.reviewFirst} disabled={dock.reviewBusy || !dock.reviewable} />
        </>
      )}
    </div>
  );

  return (
    <div
      className="mx-[var(--chat-space-block)] rounded-t-lg bg-dock-surface"
      data-draft-dock="settled"
    >
      {/* The WHOLE first line is the expand/collapse target (several files) or
          opens the review (one); buttons intercept their own clicks. Tiny
          chevron-only targets read as broken affordance. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the chevron button inside is the keyboard-accessible toggle; the row onClick is a mouse convenience. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same — mouse-convenience toggle over a semantic inner button. */}
      <div
        onClick={multi ? () => setExpanded((value) => !value) : dock.reviewFirst}
        className={cn(
          "flex min-h-7 items-center gap-[var(--chat-space-inline)] px-[var(--chat-card-pad-x)] text-caption text-prose-foreground",
          multi && "cursor-pointer transition-colors hover:bg-muted/50",
        )}
      >
        {multi ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? t`Collapse changes` : t`Expand changes`}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
            className="focus-ring -ml-0.5 grid size-4 shrink-0 place-items-center rounded-sm text-ink-subtle"
          >
            <ChevronRight
              className={cn("size-3 transition-transform", expanded && "rotate-90")}
              aria-hidden
            />
          </button>
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-[var(--chat-space-inline)] overflow-hidden">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-jade-text" />
          {/* min() keeps the 12ch floor from padding short names with dead space */}
          <span className="min-w-[min(12ch,max-content)] shrink truncate">
            {multi ? <Trans>{dock.files.length} documents</Trans> : only?.name}
          </span>
          {dock.changeCount !== null ? (
            <span className="shrink-0 whitespace-nowrap text-ink-subtle">
              <ChangeCount count={dock.changeCount} />
            </span>
          ) : null}
        </div>
        {noted ? null : commands}
      </div>

      {noted ? (
        <>
          <div className="space-y-0.5 px-[var(--chat-card-pad-x)] pb-1 text-caption text-ink-muted">
            <DockNotesText notes={notes} />
          </div>
          <div className="flex justify-end px-[var(--chat-card-pad-x)] pb-1 text-caption text-prose-foreground">
            {commands}
          </div>
        </>
      ) : null}

      {/* One document: its trouble sits under the strip. Several: on the
          file's row, so the strip opens to show it. */}
      {!multi && only ? <FileTrouble dock={dock} file={only} /> : null}

      {multi && expanded ? (
        // Capped so a long list of files scrolls inside the dock instead of
        // pushing the transcript off screen above the composer.
        <div className="app-scroll max-h-[min(40svh,20rem)]">
          {dock.files.map((file) => (
            <DockFileLine key={file.row.documentId} dock={dock} file={file} />
          ))}
        </div>
      ) : null}

      {footer}
    </div>
  );
}

function ChangeCount({ count }: { count: number }) {
  return <Plural value={count} one="# change" other="# changes" />;
}

/** One file in the expanded strip: its name, its count, its own notes, and what went wrong on it. */
function DockFileLine({ dock, file }: { dock: DraftDockModel; file: DockFile }) {
  const notes = dockNotes([file]);
  return (
    <div
      data-draft-dock-file={file.row.documentId}
      className="border-border-subtle border-b last:border-b-0"
    >
      <div className="group flex min-h-7 items-center gap-[var(--chat-space-inline)] pr-[var(--chat-geometry-draft-inset)] pl-[var(--chat-geometry-draft-indent)] text-caption text-prose-foreground">
        <span aria-hidden className="shrink-0 text-ink-subtle">
          ○
        </span>
        <span className="min-w-0 flex-1 truncate">{file.name}</span>
        {file.status === "loading" ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-ink-subtle" aria-hidden />
        ) : file.status === "ready" ? (
          <span className="shrink-0 whitespace-nowrap text-ink-subtle">
            <ChangeCount count={file.changes.length} />
          </span>
        ) : null}
        <span className="shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <ReviewPill
            onClick={() => dock.review(file)}
            disabled={dock.reviewBusy || !file.row.contextPath}
          />
        </span>
      </div>
      {hasNotes(notes) ? (
        <div className="space-y-0.5 pr-[var(--chat-geometry-draft-inset)] pb-1 pl-[var(--chat-geometry-draft-indent)] text-caption text-ink-muted">
          <DockNotesText notes={notes} row />
        </div>
      ) : null}
      <FileTrouble dock={dock} file={file} row />
    </div>
  );
}

/** A preview that did not load, or a command that did not land, in the strip's error voice. */
function FileTrouble({
  dock,
  file,
  row = false,
}: {
  dock: DraftDockModel;
  file: DockFile;
  row?: boolean;
}) {
  const failure = dock.fileFailure(file);
  if (!failure && file.status !== "error") return null;
  return (
    <p
      className={cn(
        "flex items-baseline gap-[var(--chat-space-inline)] border-border-subtle border-t py-[var(--chat-card-pad-y)] text-destructive text-caption",
        row
          ? "pr-[var(--chat-geometry-draft-inset)] pl-[var(--chat-geometry-draft-indent)]"
          : "px-[var(--chat-card-pad-x)]",
      )}
      role="alert"
      {...{
        [row ? "data-draft-dock-row-error" : "data-draft-dock-strip-error"]:
          failure?.failure.code ?? "unreadable",
      }}
    >
      <span className="min-w-0 flex-1">
        {failure ? (
          <DockFailureText failure={failure} fileName={file.name} />
        ) : (
          <Trans>Changes couldn't load.</Trans>
        )}
      </span>
      {!failure && file.retry ? (
        <button
          type="button"
          onClick={file.retry}
          className="text-button shrink-0 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
        >
          <Trans>Retry</Trans>
        </button>
      ) : null}
    </p>
  );
}

function ReviewPill({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="focus-ring inline-flex h-5 shrink-0 items-center rounded-sm bg-primary px-2 text-caption font-semibold text-primary-foreground disabled:opacity-50"
    >
      <Trans>Review draft</Trans>
    </button>
  );
}

/** Quiet text verb — never destructive-colored. */
function QuietButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="focus-ring shrink-0 whitespace-nowrap rounded-sm px-[var(--chat-space-block)] py-0.5 text-ink-muted hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  );
}
