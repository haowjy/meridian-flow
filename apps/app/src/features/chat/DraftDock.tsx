import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { useRef, useState } from "react";
import { FoldToggle } from "@/components/ui/fold-toggle";
import {
  CommandNotice,
  noticeAction,
  useApplyAllQuestion,
  useDraftNotice,
  useDraftNoticeWords,
} from "@/features/draft-review/CommandNotice";
import { DraftFileRow } from "@/features/draft-review/DraftFileRow";
import { ReviewActions } from "@/features/draft-review/ReviewActions";
import { hasApply } from "@/features/draft-review/tree-line";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { useFocusSuccession } from "@/lib/focus-follow";
import type { DraftDockModel } from "./useDraftDock";

export function DraftDock({ dock }: { dock: DraftDockModel }) {
  const [expanded, setExpanded] = useState(false);
  const touch = useCoarsePointer();
  const words = useDraftNoticeWords(useDraftNotice(dock.draftId));

  const root = useRef<HTMLDivElement>(null);
  useFocusSuccession(root, dock.mounted, noticeAction);
  const count = dock.files.length;
  const { question, start: startApply } = useApplyAllQuestion({
    deleting: count > 1 ? dock.deletingToApply : [],
    apply: dock.apply,
    confirm: <Trans>Apply</Trans>,
    disabled: !dock.canCommand,
  });
  const asking = question !== null;

  if (!dock.mounted) return null;

  return (
    <div
      ref={root}
      className="@container/dock -mb-3 rounded-t-lg bg-review pb-3"
      data-draft-dock="settled"
    >
      {count > 0 ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the FoldToggle inside is the keyboard toggle; the row's click is a mouse convenience. slop-lint: allow suppression the reason is stated in this comment
        // biome-ignore lint/a11y/noStaticElementInteractions: same: a mouse convenience over the FoldToggle. slop-lint: allow suppression the reason is stated in this comment
        <div
          onClick={asking ? undefined : () => setExpanded((value) => !value)}
          className="flex cursor-pointer flex-wrap items-center gap-x-[var(--chat-space-inline)] gap-y-0.5 min-h-(--strip-row) py-1 pr-2 pl-[var(--chat-card-pad-x)] text-xs text-foreground @max-[25rem]/dock:gap-x-1 @max-[25rem]/dock:pl-1"
        >
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
              <Plural value={count} one="# document changed" other="# documents changed" />
            </span>
          </FoldToggle>
          {asking ? null : (
            // biome-ignore lint/a11y/useKeyWithClickEvents: pure click fence so verb buttons don't also toggle the row.
            // biome-ignore lint/a11y/noStaticElementInteractions: same — stopPropagation fence only, no interaction of its own.
            <div
              className="ml-auto flex max-w-full shrink-0 items-center justify-end"
              onClick={(event) => event.stopPropagation()}
            >
              <ReviewActions
                scope="document"
                labels={{
                  apply: t`Apply this chat's draft`,
                  discard: t`Discard this chat's draft`,
                }}
                density="full"
                disabled={!dock.canCommand}
                onDiscard={dock.discard}
                onApply={dock.canApply ? startApply : undefined}
              />
            </div>
          )}
        </div>
      ) : null}
      {expanded && count > 0 ? (
        <ul className={"app-scroll max-h-[min(40svh,20rem)] px-1"}>
          {dock.files.map((file) => (
            <DraftFileRow
              key={file.documentId}
              projectId={dock.projectId}
              draftId={dock.draftId}
              file={file}
              depth={0}
              fault={null}
              active={false}
              canApply={hasApply(file.item)}
              controller={dock.controller}
              touch={touch}
              notice={words.word(file.documentId)}
            />
          ))}
        </ul>
      ) : null}
      {dock.more > 0 ? (
        <div className="flex pr-2 pb-1 pl-[var(--chat-card-pad-x)] @max-[25rem]/dock:pl-1">
          <button
            type="button"
            className="text-button flex items-center text-xs coarse:min-h-11"
            onClick={dock.showChanges}
          >
            <Trans>{dock.more} more in this Work</Trans>
          </button>
        </div>
      ) : null}
      <CommandNotice notice={dock.notice} question={question} />
    </div>
  );
}
