/** Composer-attached strip for this chat's pending changes. Summary and commands share one row; multiple files expand in place. Failures stay on their file. */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { DockFailureText } from "./DraftDockMessages";
import type { DockFile } from "./draft-dock-files";
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
  const confirming = confirmingDiscard && dock.showCommands;
  const commands = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: pure click fence so verb buttons don't also toggle the row.
    // biome-ignore lint/a11y/noStaticElementInteractions: same — stopPropagation fence only, no interaction of its own.
    <div
      className="ml-auto flex max-w-full shrink-0 items-center justify-end gap-[var(--chat-space-inline)]"
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
          "flex min-h-7 items-center gap-x-[var(--chat-space-inline)] gap-y-0.5 px-[var(--chat-card-pad-x)] py-0.5 text-caption text-prose-foreground",
          multi && "cursor-pointer transition-colors hover:bg-muted/50",
        )}
      >
        {/* The summary holds a floor (its basis) and the commands keep their
            width, so a dock too narrow for both sends the commands to their
            own right-aligned line instead of squeezing the name to nothing. */}
        <div className="flex min-w-0 flex-1 items-center gap-[var(--chat-space-inline)]">
          {multi ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={expanded ? t`Collapse changes` : t`Expand changes`}
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((value) => !value);
              }}
              className="focus-ring -ml-0.5 grid size-4 shrink-0 place-items-center rounded-sm text-ink-subtle [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
            >
              <ChevronRight
                className={cn("size-3 transition-transform", expanded && "rotate-90")}
                aria-hidden
              />
            </button>
          ) : null}
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-jade-text" />
          {/* min() keeps the 12ch floor from padding short names with dead space */}
          <span className="min-w-0 shrink truncate">
            {multi ? <Trans>{dock.files.length} documents</Trans> : only?.name}
          </span>
          {dock.changeCount !== null ? (
            <span className="shrink-0 whitespace-nowrap text-ink-subtle">
              <ChangeCount count={dock.changeCount} />
            </span>
          ) : null}
        </div>
        {!multi && only ? <FileTrouble dock={dock} file={only} /> : null}
        {commands}
      </div>

      {multi && expanded ? (
        // Capped so a long list of files scrolls inside the dock instead of
        // pushing the transcript off screen above the composer.
        <div className="app-scroll max-h-[min(40svh,20rem)]">
          {dock.files.map((file) => (
            <DockFileLine key={file.row.documentId} dock={dock} file={file} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ChangeCount({ count }: { count: number }) {
  return <Plural value={count} one="# change" other="# changes" />;
}

/** One expanded file line: name, count, Review and any held failure. */
function DockFileLine({ dock, file }: { dock: DraftDockModel; file: DockFile }) {
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
        <FileTrouble dock={dock} file={file} row />
        <span className="shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <ReviewPill
            onClick={() => dock.review(file)}
            disabled={dock.reviewBusy || !file.row.contextPath}
          />
        </span>
      </div>
    </div>
  );
}

/**
 * What went wrong on a file, in the strip's error voice: a command or launch
 * that did not land, and a preview that did not load. They are independent, so
 * both show when both are held, and Retry stays with the unreadable preview.
 */
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
  const unreadable = file.status === "error";
  if (!failure && !unreadable) return null;
  return (
    <>
      {failure ? (
        <TroubleLine row={row} code={failure.failure.code}>
          <DockFailureText failure={failure} fileName={file.name} />
        </TroubleLine>
      ) : null}
      {unreadable ? (
        <TroubleLine
          row={row}
          code="unreadable"
          action={
            file.retry ? (
              <button
                type="button"
                onClick={file.retry}
                className="text-button shrink-0 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
              >
                <Trans>Retry</Trans>
              </button>
            ) : null
          }
        >
          <Trans>Changes couldn't load.</Trans>
        </TroubleLine>
      ) : null}
    </>
  );
}

function TroubleLine({
  row,
  code,
  action,
  children,
}: {
  row: boolean;
  code: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <p
      className="flex min-w-0 max-w-[50%] items-center gap-[var(--chat-space-inline)] text-destructive text-caption"
      role="alert"
      {...{ [row ? "data-draft-dock-row-error" : "data-draft-dock-strip-error"]: code }}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </p>
  );
}

function ReviewPill({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="focus-ring inline-flex h-5 shrink-0 items-center justify-center rounded-sm bg-primary px-2 text-caption font-semibold text-primary-foreground disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
    >
      <Trans>Review</Trans>
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
      className="focus-ring shrink-0 whitespace-nowrap rounded-sm px-[var(--chat-space-block)] py-0.5 text-ink-muted hover:text-foreground disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
    >
      {children}
    </button>
  );
}
