/** Composer-attached strip for this chat's pending changes. Summary and commands share one row; changes expand in place; a command's question asks in the footer below the files. A file's refused command shows once, in its status line. */

import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  CommandNotice,
  type CommandQuestion,
  RestoreQuestion,
} from "@/features/draft-review/CommandNotice";
import { DocumentChangeRows } from "@/features/draft-review/DocumentChangeRows";
import { DraftCommandStatus } from "@/features/draft-review/DraftCommandStatus";
import { DraftImagePreview } from "@/features/draft-review/DraftImagePreview";
import { isWholeDocumentChange } from "@/features/draft-review/draft-changes";
import { useDraftView } from "@/features/draft-review/useDraftView";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { cn } from "@/lib/utils";
import type { DockFile } from "./draft-dock-files";
import type { DraftDockModel } from "./useDraftDock";

export function DraftDock({ dock }: { dock: DraftDockModel }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  /** Deleted documents an Apply of several files would bring back, asked about first (D79). */
  const [restoring, setRestoring] = useState<readonly DockFile[] | null>(null);
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
  const askingRestore = restoring !== null && restoring.length > 0 && dock.showCommands;
  const ids = (files: readonly DockFile[]) => new Set(files.map((file) => file.row.documentId));
  // A delete the strip hadn't shown yet holds those files back; several ask again by name.
  const apply = (restore: ReadonlySet<string>) =>
    void dock.apply(restore).then((held) => {
      if (held.length > 0 && multi) setRestoring(held);
    });
  // One file's row shows its delete, so its Apply already says to bring it back.
  const startApply = () =>
    multi && dock.deletedToApply.length > 0
      ? setRestoring(dock.deletedToApply)
      : apply(ids(dock.deletedToApply));
  // One question at a time, in the footer below the files: opening it never moves a row.
  const question: CommandQuestion | null = askingRestore
    ? {
        kind: "restore",
        sentence: <RestoreQuestion titles={restoring.map((file) => file.name)} />,
        keep: <Trans>Cancel</Trans>,
        confirm: <Trans>Apply</Trans>,
        onKeep: () => setRestoring(null),
        onConfirm: () => {
          setRestoring(null);
          apply(ids(restoring));
        },
        disabled: !dock.canCommand,
      }
    : confirming
      ? {
          kind: "discard",
          sentence: <Trans>Discard this chat's changes?</Trans>,
          keep: <Trans>Keep</Trans>,
          confirm: <Trans>Discard</Trans>,
          onKeep: () => setConfirmingDiscard(false),
          onConfirm: () => {
            setConfirmingDiscard(false);
            dock.discard();
          },
          disabled: !dock.canCommand,
        }
      : null;
  const commands = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: pure click fence so verb buttons don't also toggle the row.
    // biome-ignore lint/a11y/noStaticElementInteractions: same — stopPropagation fence only, no interaction of its own.
    <div
      className="ml-auto flex max-w-full shrink-0 items-center justify-end gap-[var(--chat-space-inline)] @max-[25rem]/dock:gap-1"
      onClick={(event) => event.stopPropagation()}
    >
      {confirming || askingRestore ? null : dock.showCommands ? (
        <>
          <QuietButton
            onClick={() => (multi ? setConfirmingDiscard(true) : dock.discard())}
            disabled={!dock.canCommand}
          >
            <Trans>Discard</Trans>
          </QuietButton>
          {dock.canApply ? (
            <QuietButton onClick={startApply} disabled={!dock.canCommand}>
              <Trans>Apply</Trans>
            </QuietButton>
          ) : null}
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
        onClick={
          confirming || askingRestore
            ? undefined
            : () => {
                dock.controller.dismissNotice();
                setExpanded((value) => !value);
              }
        }
        className={cn(
          "flex min-h-7 items-center gap-x-[var(--chat-space-inline)] gap-y-0.5 px-[var(--chat-card-pad-x)] @max-[25rem]/dock:px-1 @max-[25rem]/dock:gap-x-1 py-0.5 text-caption @max-[20rem]/dock:[font-size:12px] text-prose-foreground",
          multi && "cursor-pointer transition-colors hover:bg-muted/50",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-[var(--chat-space-inline)] @max-[25rem]/dock:gap-1">
          {
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={expanded ? t`Collapse changes` : t`Expand changes`}
              onClick={(event) => {
                event.stopPropagation();
                dock.controller.dismissNotice();
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
          {trouble ||
            (dock.changeCount !== null ? (
              <span className="hidden shrink-0 whitespace-nowrap text-ink-subtle @min-[25rem]/dock:inline">
                <ChangeCount count={dock.changeCount} />
              </span>
            ) : null)}
        </div>
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
      <CommandNotice commands={dock.controller} question={question} />
      <DraftImagePreview target={dock.imagePreview} onClose={dock.closeImagePreview} />
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
  const touch = useCoarsePointer();
  const view = useDraftView(
    {
      projectId: dock.projectId,
      workId: dock.workId,
      documentId: file.row.documentId,
      itemKey: file.row.draft.itemKey,
    },
    { controller: dock.controller, enabled: true, item: file.row.draft },
  );
  const own = new Set(file.changes.map((change) => change.id));
  const items = view.items.filter(({ change }) => own.has(change.id));
  const wholeDocument = file.status === "ready" && isWholeDocumentChange({ ...view, items });
  // A refused or lost command is the file's status line's (`DraftCommandStatus`), shown once.
  const trouble = file.status === "error" ? <FileTrouble file={file} row={!summary} /> : null;
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
      <DraftCommandStatus itemKey={file.row.draft.itemKey} item={file.row.draft} />
      {expanded && file.status !== "error" && !(summary && wholeDocument) ? (
        <div className={cn(summary && "app-scroll max-h-[min(40svh,20rem)]")}>
          <DocumentChangeRows
            documentName={file.name}
            view={{ ...view, items, locked: view.locked || dock.generating }}
            touch={touch}
            onSelect={(change) => dock.review(file, change)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** A preview that did not load, in the strip's error voice, with Retry beside it. */
function FileTrouble({ file, row = false }: { file: DockFile; row?: boolean }) {
  const message = t`Changes couldn't load.`;
  return (
    <p
      className={cn(
        "flex min-w-0 items-center gap-[var(--chat-space-inline)] text-destructive text-caption",
        row ? "max-w-[50%]" : "flex-1",
      )}
      role="alert"
      {...{ [row ? "data-draft-dock-row-error" : "data-draft-dock-strip-error"]: "unreadable" }}
    >
      <span className="min-w-0 flex-1 truncate" title={message}>
        {message}
      </span>
      {file.retry ? (
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

/** One document's review door, independent of the strip's expansion toggle. */
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
