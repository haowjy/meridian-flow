/**
 * Composer-attached draft dock for this chat's pending changes: one row per file with its word diff, Discard
 * and Apply. The summary and the whole chat's commands share the first row; a single file is that row. Per-change
 * review lives in the editor, the dock pane and the Work row, never here. Failures stay on their file.
 */

import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Check, ChevronRight, X } from "lucide-react";
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
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { DiscardedRow } from "@/features/draft-review/DiscardedRow";
import { DraftImagePreview } from "@/features/draft-review/DraftImagePreview";
import {
  changeWordStats,
  type DraftStats,
  DraftStatsLabel,
  sumWordStats,
} from "@/features/draft-review/draft-stats";
import { ChangeFailureText } from "@/features/draft-review/ReviewChangeParts";
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
  /** This chat's words added and removed in the file. */
  stats: DraftStats;
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
        previous.stats !== next.stats ||
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
  const stats = useMemo(() => changeWordStats(items.map((item) => item.change)), [items]);
  const actionable = view.membership.status === "ready" && items.length > 0;
  const visible =
    actionable ||
    view.membership.status !== "ready" ||
    !!view.completing ||
    !!view.discarded?.length ||
    overrode.length > 0 ||
    dock.fileFailures(file).length > 0;
  useLayoutEffect(() => {
    summary.publish(draft.itemKey, { file, draft, view, overrode, stats, visible, actionable });
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

// Shared by the summary row and every file row, so the rows align and wash the same way. The wash is the
// sidebar accent at half strength: `muted` is the dock surface's own tone, and full accent is the icon hover.
const ROW =
  "flex items-center gap-x-[var(--chat-space-inline)] px-[var(--chat-card-pad-x)] @max-[25rem]/dock:gap-x-1 @max-[25rem]/dock:px-1 text-caption @max-[20rem]/dock:[font-size:12px] text-prose-foreground transition-colors";

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
  const known =
    views.length === dock.files.length &&
    files.every(({ view }) => view.membership.status === "ready");
  const canCommand = dock.canCommand && known;
  if (!dock.mounted || (files.length === 0 && dock.discardedFiles.length === 0)) return null;

  const multi = files.length > 1;
  const only = multi ? null : (files[0] ?? null);
  const confirming = confirmingDiscard && showCommands;
  const commands = (
    // biome-ignore lint/a11y/useKeyWithClickEvents: pure click fence so verb buttons don't also toggle or open the row.
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
  const dot = showCommands ? (
    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-jade-text" />
  ) : null;

  return (
    <div
      className="@container/dock rounded-t-lg bg-dock-surface"
      data-draft-dock="settled"
      aria-busy={files.some(({ view }) => view.membership.status === "loading")}
    >
      {multi ? (
        // The whole summary row toggles the list; the chevron is its keyboard door and the verbs fence their own clicks.
        // biome-ignore lint/a11y/useKeyWithClickEvents: the chevron button inside is the keyboard-accessible toggle; the row onClick is a mouse convenience.
        // biome-ignore lint/a11y/noStaticElementInteractions: same — mouse-convenience toggle over a semantic inner button.
        <div
          onClick={confirming ? undefined : () => setExpanded((value) => !value)}
          className={cn(
            ROW,
            touch ? "min-h-11" : "min-h-8",
            !confirming && "cursor-pointer hover:bg-sidebar-accent/50",
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
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? t`Collapse files` : t`Expand files`}
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
              {dot}
              <span className="min-w-0 shrink truncate">
                <Trans>{files.length} documents</Trans>
              </span>
              <span className="shrink-0">
                {/* A partial total would read as the whole chat's: it waits, like the summary commands. */}
                {known ? (
                  <DraftStatsLabel stats={sumWordStats(files.map((read) => read.stats))} />
                ) : null}
              </span>
              {expanded || !dock.pendingMode ? null : <FileCommandStatus mode={dock.pendingMode} />}
            </div>
          )}
          {commands}
        </div>
      ) : only ? (
        <DockFileRow dock={dock} read={only} lead={dot} commands={commands} />
      ) : null}
      {multi && expanded ? (
        <ul className="app-scroll max-h-[min(40svh,20rem)] border-border-subtle border-t">
          {files.map((read) => (
            <li key={read.file.row.documentId}>
              <DockFileRow dock={dock} read={read} nested />
            </li>
          ))}
        </ul>
      ) : null}
      {dock.discardedFiles.length > 0 ? (
        <ul className={cn((multi ? expanded : !!only) && "border-border-subtle border-t")}>
          {dock.discardedFiles.map((entry) => (
            <DiscardedRow
              key={entry.id}
              entry={entry}
              name={reviewFileTargetName(entry.subject, t`Document`)}
              touch={touch}
              onUndo={() => dock.discards.undo(entry.id)}
              className="px-[var(--chat-card-pad-x)] @max-[25rem]/dock:px-1"
            />
          ))}
        </ul>
      ) : null}
      <DraftImagePreview target={dock.imagePreview} onClose={dock.closeImagePreview} />
    </div>
  );
}

/**
 * One file of the chat: its name, this chat's word diff in it, and Discard and Apply for this chat's changes
 * in it. Hover washes the row and a click opens the file's review. A single-file dock's row carries the
 * summary's dot (`lead`) and the whole chat's verbs (`commands`) instead of its own icon buttons.
 */
function DockFileRow({
  dock,
  read,
  lead = null,
  commands,
  nested = false,
}: {
  dock: DraftDockModel;
  read: DockView;
  lead?: ReactNode;
  commands?: ReactNode;
  /** Listed under the summary: the name lines up past the summary's chevron. */
  nested?: boolean;
}) {
  const touch = useCoarsePointer();
  const { file, draft, view, overrode, stats } = read;
  const failures = dock.fileFailures(file);
  const changeFailure =
    failures.length > 0 ? null : (view.items.find((item) => item.failure)?.failure ?? null);
  const state =
    view.status === "error" ? (
      <>
        {/* The failure keeps its words; the file name truncates first. */}
        <span role="alert" className="shrink-0 text-destructive">
          {t`Changes couldn’t load`}
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            view.retry?.();
          }}
          className="text-button shrink-0 px-1 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
        >
          <Trans>Retry</Trans>
        </button>
      </>
    ) : view.completing ? (
      <FileCommandStatus mode={view.completing} />
    ) : failures.length > 0 ? (
      <FileTrouble file={file} failures={failures} />
    ) : changeFailure ? (
      <TroubleLine code={changeFailure.code}>
        <ChangeFailureText failure={changeFailure} />
      </TroubleLine>
    ) : view.membership.status === "loading" ? (
      <Skeleton aria-hidden className="h-3 w-14 shrink-0" />
    ) : (
      <span className="shrink-0">
        <DraftStatsLabel stats={stats} />
      </span>
    );
  const own =
    commands === undefined && view.status !== "error" && !view.completing ? (
      <FileCommands
        disabled={
          !read.actionable || view.locked || dock.generating || dock.controller.dispositionLocked
        }
        touch={touch}
        onDiscard={() => dock.discard([file])}
        onApply={() => dock.apply([file])}
      />
    ) : null;
  return (
    <div data-draft-dock-file={file.row.documentId}>
      {/* The file name is the row's keyboard door; the row's click is a mouse convenience over it. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the name button inside opens the same review from the keyboard. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same — mouse-convenience door over a semantic inner button. */}
      <div
        onClick={() => dock.review(file)}
        className={cn(
          ROW,
          "cursor-pointer hover:bg-sidebar-accent/50",
          touch ? "min-h-11" : "min-h-8",
          nested && "pl-[calc(var(--chat-card-pad-x)+18px)] @max-[25rem]/dock:pl-[22px]",
        )}
      >
        {lead}
        {/* The name hugs its text so its focus ring marks the control, never an input-wide box. */}
        <button
          type="button"
          className={cn(
            "focus-ring -mx-1 min-w-0 shrink truncate rounded-sm px-1 text-left",
            touch && "min-h-11",
          )}
          onClick={(event) => {
            event.stopPropagation();
            dock.review(file);
          }}
        >
          {file.name}
        </button>
        <span className="min-w-0 flex-1" />
        {state}
        {commands ?? own}
      </div>
      <AppliedOverNotice
        items={overrode}
        onDismiss={() => dismissOverrode(draft)}
        touch={touch}
        className="px-[var(--chat-card-pad-x)]"
      />
    </div>
  );
}

/** A file's own Discard and Apply: icon buttons named by their tooltips. */
function FileCommands({
  disabled,
  touch,
  onDiscard,
  onApply,
}: {
  disabled: boolean;
  touch: boolean;
  onDiscard: () => void;
  onApply: () => void;
}) {
  const size = touch ? "size-11 [&_svg:not([class*='size-'])]:size-5" : "size-7";
  return (
    <span className="-mr-1 flex shrink-0 items-center">
      <IconButton
        tooltip={t`Discard`}
        disabled={disabled}
        className={size}
        onClick={(event) => {
          event.stopPropagation();
          onDiscard();
        }}
      >
        <X aria-hidden />
      </IconButton>
      <IconButton
        tooltip={t`Apply`}
        disabled={disabled}
        className={cn("text-primary hover:text-primary", size)}
        onClick={(event) => {
          event.stopPropagation();
          onApply();
        }}
      >
        <Check aria-hidden />
      </IconButton>
    </span>
  );
}

/** What went wrong on a file, in the draft dock's error voice: a command or launch that did not land. */
function FileTrouble({ file, failures }: { file: DockFile; failures: readonly DockFileFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <>
      {failures.map((failure) => (
        <TroubleLine key={failure.kind} code={failure.failure.code}>
          <DockFailureText failure={failure} fileName={file.name} />
        </TroubleLine>
      ))}
    </>
  );
}

function TroubleLine({ code, children }: { code: string; children: React.ReactNode }) {
  const { i18n } = useLingui();
  const text = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    // Read the localized rendered copy, including refusal reasons, without duplicating it.
    if (text.current) text.current.title = text.current.textContent ?? "";
  }, [children, i18n.locale]);
  return (
    <p
      className="flex min-w-0 max-w-[60%] items-center text-caption text-destructive"
      role="alert"
      data-draft-dock-error={code}
    >
      <span ref={text} className="min-w-0 flex-1 truncate">
        {children}
      </span>
    </p>
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
