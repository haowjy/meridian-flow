/** Composer-attached strip for this chat's pending changes. Every count on it counts what its commands act on; what else the Work holds is a link to Changes. Summary and commands share one row; changes expand in place; a command's question asks in the footer below the files. A file's refused command shows once, in its status line. */

import { plural, t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { FoldToggle } from "@/components/ui/fold-toggle";
import {
  ApplyAllQuestion,
  CommandNotice,
  type CommandQuestion,
  noticeAction,
} from "@/features/draft-review/CommandNotice";
import { DocumentChangeRows } from "@/features/draft-review/DocumentChangeRows";
import { DeletedLiveTag, DraftCommandStatus } from "@/features/draft-review/DraftCommandStatus";
import { DraftImagePreview } from "@/features/draft-review/DraftImagePreview";
import { isWholeDocumentChange } from "@/features/draft-review/draft-changes";
import { ReviewActions } from "@/features/draft-review/ReviewActions";
import { treeLineSentence } from "@/features/draft-review/tree-line";
import { useDraftView } from "@/features/draft-review/useDraftView";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { useFocusSuccession } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";
import type { DockFile } from "./draft-dock-files";
import type { DraftDockModel } from "./useDraftDock";

export function DraftDock({ dock }: { dock: DraftDockModel }) {
  const [expanded, setExpanded] = useState(false);
  /** What an Apply of several files deletes or brings back, asked about first. */
  const [asking, setAsking] = useState<{
    deleting: readonly DockFile[];
    restoring: readonly DockFile[];
  } | null>(null);

  const root = useRef<HTMLDivElement>(null);
  useFocusSuccession(root, dock.mounted, noticeAction);

  if (!dock.mounted) return null;

  const multi = dock.files.length > 1;
  const only = dock.files[0];
  const askingApply = asking !== null && dock.showCommands;
  // One file's row shows its delete, so its Apply already says to delete or bring it back.
  const startApply = () =>
    multi && (dock.deletedToApply.length > 0 || dock.deletingToApply.length > 0)
      ? setAsking({ deleting: dock.deletingToApply, restoring: dock.deletedToApply })
      : dock.apply();
  // One question at a time, in the footer below the files: opening it never moves a row.
  const question: CommandQuestion | null = askingApply
    ? {
        kind: "apply-all",
        sentence: (
          <ApplyAllQuestion
            deleting={asking.deleting.map((file) => file.name)}
            restoring={asking.restoring.map((file) => ({
              name: file.name,
              scheme: file.row.draft.deletedFrom?.scheme,
            }))}
          />
        ),
        keep: <Trans>Cancel</Trans>,
        confirm: <Trans>Apply</Trans>,
        onKeep: () => setAsking(null),
        onConfirm: () => {
          setAsking(null);
          dock.apply();
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
      {askingApply ? null : dock.showCommands ? (
        <ReviewActions
          scope={multi ? "all" : "change"}
          labels={stripLabels(dock.files.length, only?.name ?? "", dock.changeCount)}
          density="full"
          disabled={!dock.canCommand}
          onDiscard={dock.discard}
          onApply={dock.canApply ? startApply : undefined}
        />
      ) : null}
    </div>
  );

  // The whole first line folds and unfolds the changes, except its commands. The changes'
  // own rows open the draft.
  const summary = () => (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the FoldToggle inside is the keyboard toggle; the row's click is a mouse convenience. slop-lint: allow suppression the reason is stated in this comment
    // biome-ignore lint/a11y/noStaticElementInteractions: same: a mouse convenience over the FoldToggle. slop-lint: allow suppression the reason is stated in this comment
    <div
      onClick={askingApply ? undefined : () => setExpanded((value) => !value)}
      className="flex cursor-pointer flex-wrap items-center gap-x-[var(--chat-space-inline)] gap-y-0.5 min-h-(--strip-row) py-1 pr-2 pl-[var(--chat-card-pad-x)] text-xs text-foreground @max-[25rem]/dock:gap-x-1 @max-[25rem]/dock:pl-1"
    >
      {/* Sized by its content, so a question too wide to sit beside it wraps to a line of its own. */}
      <FoldToggle
        open={expanded}
        onToggle={(event) => {
          event.stopPropagation();
          setExpanded((value) => !value);
        }}
        inline
        className="coarse:min-h-11 min-w-[12ch] flex-auto"
      >
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-jade-text" />
        <span className="min-w-0 truncate text-foreground">
          {multi ? (
            <Plural value={dock.files.length} one="# document" other="# documents" />
          ) : only ? (
            fileLabel(only)
          ) : null}
        </span>
      </FoldToggle>
      {only && !multi ? <DeletedLiveTag item={only.row.draft} /> : null}
      {multi || dock.changeCount === null ? null : (
        <span className="hidden shrink-0 whitespace-nowrap text-muted-foreground @min-[25rem]/dock:inline">
          <ChangeCount count={dock.changeCount} />
        </span>
      )}
      {commands}
    </div>
  );

  return (
    // Its background runs on behind the composer's top edge, so strip and composer read as one.
    <div
      ref={root}
      className="@container/dock -mb-3 rounded-t-lg bg-review pb-3"
      data-draft-dock="settled"
    >
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
      {dock.more > 0 ? (
        <div className="flex pr-2 pb-1 pl-[var(--chat-card-pad-x)] @max-[25rem]/dock:pl-1">
          <button
            type="button"
            className="text-button flex items-center text-xs coarse:min-h-11"
            onClick={dock.showChanges}
          >
            {dock.inWork ? (
              <Trans>{dock.more} more in this Work</Trans>
            ) : (
              <Trans>{dock.more} more to review</Trans>
            )}
          </button>
        </div>
      ) : null}
      <CommandNotice notice={dock.notice} question={question} />
      <DraftImagePreview target={dock.imagePreview} onClose={dock.closeImagePreview} />
    </div>
  );
}

/** The strip acts on this chat's changes, not the whole draft, and its names say so. */
function stripLabels(documents: number, name: string, changes: number | null) {
  if (documents > 1) {
    return {
      apply: t`Apply this chat's changes to ${documents} documents`,
      discard: t`Discard this chat's changes to ${documents} documents`,
    };
  }
  if (changes === null) {
    return {
      apply: t`Apply this chat's changes to ${name}`,
      discard: t`Discard this chat's changes to ${name}`,
    };
  }
  return {
    apply: plural(changes, {
      one: `Apply this chat's change to ${name}`,
      other: `Apply this chat's # changes to ${name}`,
    }),
    discard: plural(changes, {
      one: `Discard this chat's change to ${name}`,
      other: `Discard this chat's # changes to ${name}`,
    }),
  };
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
  summary?: () => ReactNode;
}) {
  const touch = useCoarsePointer();
  const view = useDraftView(
    {
      projectId: dock.projectId,
      ownerKey: dock.ownerKey,
      documentId: file.row.documentId,
      itemKey: file.row.draft.itemKey,
    },
    { controller: dock.controller, enabled: !file.whole, item: file.row.draft },
  );
  const own = new Set(file.changes.map((change) => change.id));
  const items = view.items.filter(({ change }) => own.has(change.id));
  const wholeDocument = isWholeDocumentChange({ ...view, items });
  // A command's progress is the file's status line's (`DraftCommandStatus`), shown once.
  const status = <DraftCommandStatus itemKey={file.row.draft.itemKey} />;
  if (!summary && !expanded) return null;
  if (file.whole && !summary)
    return (
      <div
        data-draft-dock-file={file.row.documentId}
        className="border-border-subtle border-b last:border-b-0"
      >
        <div className="flex min-h-7 items-center gap-1.5 pr-2 pl-2 text-xs text-foreground">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left coarse:min-h-11"
            onClick={() => dock.review(file)}
          >
            <span className="min-w-0 truncate">{fileLabel(file)}</span>
            <DeletedLiveTag item={file.row.draft} />
            <span className="ml-auto shrink-0 text-muted-foreground">
              <ChangeCount count={file.count} />
            </span>
          </button>
          <ReviewActions
            scope="change"
            density="icon"
            touch={touch}
            labels={{
              apply: t`Apply this chat's changes to ${file.name}`,
              discard: t`Discard this chat's changes to ${file.name}`,
            }}
            disabled={!dock.canCommand}
            onDiscard={() => dock.discardFile(file)}
            onApply={() => dock.applyFile(file)}
          />
        </div>
        {status}
      </div>
    );
  return (
    <div
      data-draft-dock-file={file.row.documentId}
      className="border-border-subtle border-b last:border-b-0"
    >
      {summary ? (
        summary()
      ) : expanded && !wholeDocument ? (
        <div className="flex min-h-7 items-center gap-1.5 px-2 text-xs text-foreground">
          <span className="min-w-0 truncate">{fileLabel(file)}</span>
          <DeletedLiveTag item={file.row.draft} />
        </div>
      ) : null}
      {/* A file with no header row keeps its status line under its one row, which it describes. */}
      {wholeDocument && !summary ? null : status}
      {expanded ? (
        <div className={cn(summary && "app-scroll max-h-[min(40svh,20rem)]")}>
          <DocumentChangeRows
            documentName={file.name}
            notice={summary ? undefined : <DeletedLiveTag item={file.row.draft} />}
            view={{ ...view, items, locked: view.locked || dock.generating }}
            touch={touch}
            onSelect={(change) => dock.review(file, change)}
          />
        </div>
      ) : null}
      {wholeDocument && !summary ? status : null}
    </div>
  );
}

/** A file's name, or what its one change does when that is a move or delete ("ch13: Deleted"). */
function fileLabel(file: DockFile): string {
  const [only] = file.changes;
  return file.changes.length === 1 && only?.tree ? treeLineSentence(only.tree) : file.name;
}
