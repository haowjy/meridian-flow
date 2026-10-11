/** Composer-attached strip for this chat's pending changes. Summary and commands share one row; changes expand in place. Failures stay on their file. */
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Plural, Trans } from "@lingui/react/macro";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DocumentChangeRows } from "@/features/draft-review/DocumentChangeRows";
import { useDraftChanges } from "@/features/draft-review/useDraftChanges";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { cn } from "@/lib/utils";
import { DockFailureText } from "./DraftDockMessages";
import type { DockFile } from "./draft-dock-files";
import type { DockFileFailure, DraftDockModel } from "./useDraftDock";

export function DraftDock({ dock }: { dock: DraftDockModel }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const troubledFileCount = dock.files.filter(
    (file) => file.status === "error" || dock.fileFailures(file).length > 0,
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
      className="ml-auto flex max-w-full shrink-0 items-center justify-end gap-[var(--chat-space-inline)] @max-[25rem]/dock:gap-1"
      onClick={(event) => event.stopPropagation()}
    >
      {confirming ? (
        <>
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

  const summary = (trouble: ReactNode = null) => (
    <>
      {/* The whole first line toggles expansion; command buttons intercept their own clicks. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the chevron button inside is the keyboard-accessible toggle; the row onClick is a mouse convenience. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same — mouse-convenience toggle over a semantic inner button. */}
      <div
        onClick={confirming ? undefined : () => setExpanded((value) => !value)}
        className={cn(
          "flex min-h-7 items-center gap-x-[var(--chat-space-inline)] gap-y-0.5 px-[var(--chat-card-pad-x)] @max-[25rem]/dock:px-1 @max-[25rem]/dock:gap-x-1 py-0.5 text-caption @max-[20rem]/dock:[font-size:12px] text-prose-foreground",
          multi && "cursor-pointer transition-colors hover:bg-muted/50",
        )}
      >
        {confirming ? (
          <span
            data-draft-dock-confirmation
            className="min-w-0 flex-1 truncate text-ink-muted"
            title={t`Discard this chat's changes?`}
          >
            <Trans>Discard this chat's changes?</Trans>
          </span>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-[var(--chat-space-inline)] @max-[25rem]/dock:gap-1">
            {
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
            }
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-jade-text" />
            {trouble || (
              <>
                <span className="min-w-[10ch] shrink truncate">
                  {multi ? <Trans>{dock.files.length} documents</Trans> : only?.name}
                </span>
                {dock.changeCount !== null ? (
                  <span className="hidden shrink-0 whitespace-nowrap text-ink-subtle @min-[25rem]/dock:inline">
                    <ChangeCount count={dock.changeCount} />
                  </span>
                ) : null}
              </>
            )}
          </div>
        )}
        {commands}
      </div>
    </>
  );

  return (
    <div className="@container/dock rounded-t-lg bg-dock-surface" data-draft-dock="settled">
      {multi ? summary() : null}
      <div className={cn(expanded && multi && "app-scroll max-h-[min(40svh,20rem)]")}>
        {dock.files.map((file) => (
          <DockFileLine
            key={file.row.documentId}
            dock={dock}
            file={file}
            expanded={expanded}
            summary={multi ? undefined : summary}
          />
        ))}
      </div>
    </div>
  );
}

function ChangeCount({ count }: { count: number }) {
  return <Plural value={count} one="# change" other="# changes" />;
}

/** The chat's changes, with file headers only when the summary names multiple documents. */
function DockFileLine({
  dock,
  file,
  expanded,
  summary,
}: {
  dock: DraftDockModel;
  file: DockFile;
  expanded: boolean;
  summary?: (trouble: ReactNode) => ReactNode;
}) {
  const touch = usePhoneShell() ?? false;
  const view = useDraftChanges(
    {
      projectId: dock.projectId,
      workId: dock.workId,
      documentId: file.row.documentId,
      draftId: file.row.draft.draftId,
    },
    { controller: dock.controller, enabled: expanded },
  );
  const own = new Set(file.changes.map((change) => change.classId));
  const items = view.items.filter(({ change }) => own.has(change.classId));
  // Ownership comes from the rows that will actually render, not the kind of document.
  const renderedItems = expanded && file.status !== "error" && view.status === "ready" ? items : [];
  const failures = dock.fileFailures(file).filter(
    (held) =>
      !renderedItems.some((item) => {
        if (held.kind === "draft") return item.draftFailure === held.failure;
        if (item.draftFailure || !item.failure) return false;
        return (
          item.failure.code === held.failure.code &&
          item.failure.mode === held.failure.mode &&
          item.failure.serverCode === held.failure.serverCode &&
          item.failure.serverReason === held.failure.serverReason
        );
      }),
  );
  const trouble =
    failures.length > 0 || file.status === "error" ? (
      <FileTrouble file={file} failures={failures} row={!summary} />
    ) : null;
  if (!summary && !expanded) return null;
  return (
    <div
      data-draft-dock-file={file.row.documentId}
      className="border-border-subtle border-b last:border-b-0"
    >
      {summary ? (
        summary(trouble)
      ) : expanded ? (
        <div className="flex min-h-7 items-center gap-1 px-2 text-caption text-prose-foreground">
          <button
            type="button"
            className={cn("focus-ring min-w-[12ch] flex-1 truncate text-left", touch && "min-h-11")}
            onClick={() => dock.review(file)}
          >
            {file.name}
          </button>
          {trouble}
        </div>
      ) : null}
      {expanded && file.status !== "error" ? (
        <div className={cn(summary && "app-scroll max-h-[min(40svh,20rem)]")}>
          <DocumentChangeRows
            view={{ ...view, items, locked: view.locked || dock.generating }}
            touch={touch}
            onSelect={(change) => dock.review(file, change)}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * What went wrong on a file, in the strip's error voice: a command or launch
 * that did not land, and a preview that did not load. They are independent, so
 * both show when both are held, and Retry stays with the unreadable preview.
 */
function FileTrouble({
  file,
  failures,
  row = false,
}: {
  file: DockFile;
  failures: readonly DockFileFailure[];
  row?: boolean;
}) {
  const unreadable = file.status === "error";
  if (failures.length === 0 && !unreadable) return null;
  return (
    <>
      {failures.map((failure) => (
        <TroubleLine key={failure.kind} row={row} code={failure.failure.code}>
          <DockFailureText failure={failure} fileName={file.name} />
        </TroubleLine>
      ))}
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
  const { i18n } = useLingui();
  const text = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    // Read the localized rendered copy, including refusal reasons, without duplicating it.
    if (text.current) text.current.title = text.current.textContent ?? "";
  }, [children, i18n.locale]);
  return (
    <p
      className={cn(
        "flex min-w-0 items-center gap-[var(--chat-space-inline)] text-destructive text-caption",
        row ? "max-w-[50%]" : "flex-1",
      )}
      role="alert"
      {...{ [row ? "data-draft-dock-row-error" : "data-draft-dock-strip-error"]: code }}
    >
      <span ref={text} className="min-w-0 flex-1 truncate">
        {children}
      </span>
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
      className="focus-ring inline-flex h-5 shrink-0 items-center justify-center rounded-sm bg-primary px-2 @max-[25rem]/dock:px-1 text-caption @max-[20rem]/dock:[font-size:12px] font-semibold text-primary-foreground disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
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
      className="focus-ring shrink-0 whitespace-nowrap rounded-sm px-[var(--chat-space-block)] py-0.5 @max-[25rem]/dock:px-1 @max-[20rem]/dock:px-0 text-ink-muted hover:text-foreground disabled:opacity-50 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
    >
      {children}
    </button>
  );
}
