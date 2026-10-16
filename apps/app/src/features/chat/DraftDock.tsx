/** Composer-attached draft dock for this chat's pending changes. Summary and commands share one row; changes expand in place. Failures stay on their file. */

import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { ChevronRight } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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

type DockView = {
  file: DockFile;
  draft: Parameters<typeof useDraftView>[0];
  view: ReturnType<typeof useDraftView>;
  overrode: ReturnType<typeof draftOverrode>;
  visible: boolean;
  actionable: boolean;
};

/** One keyed owner for the dock's summary, rows and command targets. Readers never copy prefixes. */
function createMembershipSummary() {
  const views = new Map<string, DockView>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const notify = () => {
    revision++;
    for (const listener of listeners) listener();
  };
  return {
    views,
    snapshot: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(key: string, next: DockView) {
      const previous = views.get(key);
      views.set(key, next);
      // Command callbacks follow the latest binding without making every render a membership change.
      if (
        !previous ||
        previous.file !== next.file ||
        previous.visible !== next.visible ||
        previous.actionable !== next.actionable ||
        previous.overrode !== next.overrode ||
        previous.view.items !== next.view.items ||
        previous.view.discarded !== next.view.discarded ||
        previous.view.status !== next.view.status ||
        previous.view.wholeDocument !== next.view.wholeDocument ||
        previous.view.membership.status !== next.view.membership.status ||
        previous.view.completing !== next.view.completing ||
        previous.view.locked !== next.view.locked
      )
        notify();
    },
    remove(key: string) {
      if (views.delete(key)) notify();
    },
  };
}

function ReadDockFile({
  dock,
  file,
  summary,
}: {
  dock: DraftDockModel;
  file: DockFile;
  summary: ReturnType<typeof createMembershipSummary>;
}) {
  const draft = useMemo(
    () => ({
      projectId: dock.projectId,
      workId: dock.workId,
      documentId: file.row.documentId,
      itemKey: file.row.draft.itemKey,
    }),
    [dock.projectId, dock.workId, file.row.documentId, file.row.draft.itemKey],
  );
  const records = useDraftCommandRecords();
  const overrode = useMemo(() => draftOverrode(records, draft), [records, draft]);
  const read = useDraftView(draft, {
    controller: dock.controller,
    file: file.row,
    discards: dock.discards,
  });
  const items = useMemo(
    () =>
      read.wholeDocument
        ? read.items
        : read.items.filter((item) => item.change.members.includes(dock.threadId)),
    [read.items, read.wholeDocument, dock.threadId],
  );
  const view = { ...read, items };
  const actionable = view.membership.status === "ready" && items.length > 0;
  const visible =
    actionable ||
    view.membership.status !== "ready" ||
    !!view.completing ||
    !!view.discarded?.length ||
    overrode.length > 0 ||
    dock.fileFailures(file).length > 0;
  useLayoutEffect(() => {
    summary.publish(draft.itemKey, { file, draft, view, overrode, visible, actionable });
  });
  useLayoutEffect(() => () => summary.remove(draft.itemKey), [summary, draft.itemKey]);
  return null;
}

export function DraftDock({ dock }: { dock: DraftDockModel }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const summary = useMemo(createMembershipSummary, [dock.projectId, dock.workId, dock.threadId]);
  useSyncExternalStore(summary.subscribe, summary.snapshot, summary.snapshot);
  const views = dock.files.flatMap((file) => {
    const view = summary.views.get(file.row.draft.itemKey);
    return view ? [view] : [];
  });
  return (
    <>
      {dock.files.map((file) => (
        <ReadDockFile key={file.row.draft.itemKey} dock={dock} file={file} summary={summary} />
      ))}
      <DraftDockContent
        dock={dock}
        views={views}
        expanded={expanded}
        setExpanded={setExpanded}
        confirmingDiscard={confirmingDiscard}
        setConfirmingDiscard={setConfirmingDiscard}
      />
    </>
  );
}

function DraftDockContent({
  dock,
  views,
  expanded,
  setExpanded,
  confirmingDiscard,
  setConfirmingDiscard,
}: {
  dock: DraftDockModel;
  views: readonly DockView[];
  expanded: boolean;
  setExpanded: (value: boolean | ((previous: boolean) => boolean)) => void;
  confirmingDiscard: boolean;
  setConfirmingDiscard: (value: boolean) => void;
}) {
  const touch = useCoarsePointer();
  const troubledFileCount = views.filter(
    ({ file, view }) => dock.fileFailures(file).length > 0 || view.status === "error",
  ).length;
  // A refusal opens the draft dock so the writer sees it.
  useEffect(() => {
    if (troubledFileCount > 0) setExpanded(true);
  }, [troubledFileCount]);

  const files = views.filter((view) => view.visible);
  const commandsFor = views.filter((view) => view.actionable).map((view) => view.file);
  const showCommands = commandsFor.length > 0;
  const canCommand =
    dock.canCommand &&
    views.length === dock.files.length &&
    files.every(({ view }) => view.membership.status === "ready");
  if (!dock.mounted || (files.length === 0 && dock.discardedFiles.length === 0)) return null;

  const multi = files.length > 1;
  const only = files[0]?.file;
  const confirming = confirmingDiscard && showCommands;
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
              dock.discard(commandsFor);
            }}
            disabled={!canCommand}
          >
            <Trans>Discard</Trans>
          </QuietButton>
        </>
      ) : showCommands ? (
        <>
          <QuietButton
            onClick={() => (multi ? setConfirmingDiscard(true) : dock.discard(commandsFor))}
            disabled={!canCommand}
          >
            <Trans>Discard</Trans>
          </QuietButton>
          <QuietButton onClick={() => dock.apply(commandsFor)} disabled={!canCommand}>
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
            {showCommands ? (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-jade-text" />
            ) : null}
            {multi ? (
              <span className="min-w-[10ch] shrink truncate">
                <Trans>{files.length} documents</Trans>
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
    <div
      className="@container/dock rounded-t-lg bg-dock-surface"
      data-draft-dock="settled"
      aria-busy={files.some(({ view }) => view.membership.status === "loading")}
    >
      {multi ? summary() : null}
      <div className={cn(expanded && multi && "app-scroll max-h-[min(40svh,20rem)]")}>
        {files.map((read) => (
          <DockFileLine
            key={read.file.row.documentId}
            dock={dock}
            read={read}
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
                name={reviewFileTargetName(entry.subject, t`Document`)}
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
  read,
  expanded,
  summary,
}: {
  dock: DraftDockModel;
  read: DockView;
  expanded: boolean;
  summary?: (trouble: ReactNode) => ReactNode;
}) {
  const touch = useCoarsePointer();
  const { file, draft, view, overrode } = read;
  const { items } = view;
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
      {expanded && (!(summary && wholeDocument) || view.status === "error") ? (
        <div className={cn(summary && "app-scroll max-h-[min(40svh,20rem)]")}>
          <DocumentChangeRows
            documentName={file.name}
            view={{
              ...view,
              items,
              locked: view.locked || dock.generating || view.membership.status !== "ready",
            }}
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
