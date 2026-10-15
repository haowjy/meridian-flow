/** Composer-attached draft dock for this chat's pending changes. Summary and commands share one row; changes expand in place. Failures stay on their file. */

import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  dismissOverrode,
  draftOverrode,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { DiscardedRow } from "@/features/draft-review/DiscardedRow";
import { DocumentChangeRows } from "@/features/draft-review/DocumentChangeRows";
import { DraftImagePreview } from "@/features/draft-review/DraftImagePreview";
import { isWholeDocumentChange } from "@/features/draft-review/draft-changes";
import { FileCommandStatus } from "@/features/draft-review/ReviewCompletion";
import { AppliedOverNotice } from "@/features/draft-review/ReviewHeaderNotices";
import { reviewFileTargetName } from "@/features/draft-review/review-files";
import { useDraftView } from "@/features/draft-review/useDraftView";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { cn } from "@/lib/utils";
import { DockFailureText } from "./DraftDockMessages";
import type { DockFile } from "./draft-dock-files";
import type { DockFileFailure, DraftDockModel } from "./useDraftDock";

export function DraftDock({ dock }: { dock: DraftDockModel }) {
  const touch = useCoarsePointer();
  const [expanded, setExpanded] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const troubledFileCount = dock.files.filter((file) => dock.fileFailures(file).length > 0).length;
  // A refusal opens the draft dock so the writer sees it.
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
      ) : dock.showCommands ? (
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
    </div>
  );

  const summary = (trouble: ReactNode = null) => (
    <>
      {/* The first line toggles expansion; document names and command buttons intercept their own clicks. */}
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
            {multi ? (
              <span className="min-w-[10ch] shrink truncate">
                <Trans>{dock.files.length} documents</Trans>
              </span>
            ) : only ? (
              <DockFileName file={only} onReview={() => dock.review(only)} />
            ) : null}
            {trouble}
            {!multi || expanded || !dock.pendingMode ? null : (
              <FileCommandStatus mode={dock.pendingMode} />
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
        {dock.discardedFiles.length > 0 ? (
          <ul>
            {dock.discardedFiles.map((entry) => (
              <DiscardedRow
                key={entry.id}
                entry={entry}
                name={reviewFileTargetName(entry.file, t`Document`)}
                touch={touch}
                onUndo={() => dock.discards.undo(entry.id)}
              />
            ))}
          </ul>
        ) : null}
      </div>
      <DraftImagePreview target={dock.imagePreview} onClose={dock.closeImagePreview} />
    </div>
  );
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
  const touch = useCoarsePointer();
  const draft = {
    projectId: dock.projectId,
    workId: dock.workId,
    documentId: file.row.documentId,
    itemKey: file.row.draft.itemKey,
  };
  const overrode = draftOverrode(useDraftCommandRecords(), draft);
  const view = useDraftView(draft, {
    controller: dock.controller,
    enabled: expanded,
    file: file.row,
    discards: dock.discards,
  });
  // The draft dock shows this chat's changes: those some of whose AI writes belong to it (its own or a
  // subagent's it spawned), under any alignment the classifier cannot rule out.
  const items = useMemo(
    () =>
      view.wholeDocument
        ? view.items
        : view.items.filter((item) => item.change.members.includes(dock.threadId)),
    [view.items, view.wholeDocument, dock.threadId],
  );
  const wholeDocument = isWholeDocumentChange({ ...view, items });
  // A failure shows on the row that will render it, else on the file.
  const renderedItems =
    expanded && !(summary && wholeDocument) && view.status === "ready" ? items : [];
  const failures = dock
    .fileFailures(file)
    .filter((held) => !renderedItems.some((item) => item.draftFailure === held.failure));
  const trouble =
    failures.length > 0 || view.completing ? (
      <>
        {view.completing ? <FileCommandStatus mode={view.completing} /> : null}
        {failures.length > 0 ? (
          <FileTrouble file={file} failures={failures} row={!summary} />
        ) : null}
      </>
    ) : null;
  if (!summary && !expanded) return null;
  return (
    <div
      data-draft-dock-file={file.row.documentId}
      className="border-border-subtle border-b last:border-b-0"
    >
      {summary ? (
        summary(trouble)
      ) : expanded && !wholeDocument ? (
        <div className="flex min-h-7 items-center gap-1 px-2 text-caption text-prose-foreground">
          <DockFileName file={file} onReview={() => dock.review(file)} />
          {trouble}
        </div>
      ) : null}
      {!summary && wholeDocument ? trouble : null}
      <AppliedOverNotice
        items={overrode}
        onDismiss={() => dismissOverrode(draft)}
        touch={touch}
        className="px-2"
      />
      {expanded && !(summary && wholeDocument) ? (
        <div className={cn(summary && "app-scroll max-h-[min(40svh,20rem)]")}>
          <DocumentChangeRows
            documentName={file.name}
            view={{ ...view, items, locked: view.locked || dock.generating }}
            touch={touch}
            onSelect={(change) => dock.review(file, change.id)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** What went wrong on a file, in the draft dock's error voice: a command or launch that did not land. */
function FileTrouble({
  file,
  failures,
  row = false,
}: {
  file: DockFile;
  failures: readonly DockFileFailure[];
  row?: boolean;
}) {
  if (failures.length === 0) return null;
  return (
    <>
      {failures.map((failure) => (
        <TroubleLine key={failure.kind} row={row} code={failure.failure.code}>
          <DockFailureText failure={failure} fileName={file.name} />
        </TroubleLine>
      ))}
    </>
  );
}

function TroubleLine({
  row,
  code,
  children,
}: {
  row: boolean;
  code: string;
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
    </p>
  );
}

/** One document's review door, independent of the draft dock's expansion toggle. */
function DockFileName({ file, onReview }: { file: DockFile; onReview: () => void }) {
  const touch = useCoarsePointer();
  return (
    <button
      type="button"
      className={cn("focus-ring min-w-[12ch] flex-1 truncate text-left", touch && "min-h-11")}
      onClick={(event) => {
        event.stopPropagation();
        onReview();
      }}
    >
      {file.name}
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
