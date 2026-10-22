/**
 * ManuscriptStateNotice — what live did to the document this draft holds (D79): deleted from
 * the manuscript (Apply brings it back). Once an
 * Apply brings it back the same place says so, until the writer dismisses it or opens another
 * document; a host swap on promotion (the phone's) remounts it and must not end it. With none
 * of those, it says what a Work's pending move or delete will do to the document (D26), which
 * live doesn't show until Apply: "Ascension is renaming this to ch12-old."
 *
 * It lives in the free end of a header row the document already has (the identity row, the
 * phone's review row), never in a strip of its own: a delete lands while the writer reads, and
 * a line pushed in above the toolbar would move the page under them. The slot takes only what
 * the row leaves and adds nothing to the row's size, so its arrival never wraps or grows the
 * row. A narrow slot shows the short label; the button opens the full sentence.
 */
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Info, X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { useDocumentDraftHints } from "@/client/query/useDocumentDraftHints";
import type { ContextTab } from "@/client/stores";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { restoredSentence } from "@/features/draft-review/CommandNotice";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { isDeletedFromManuscript } from "@/features/draft-review/deleted-drafts";
import {
  type PendingTreeChange,
  treeNoticeLabel,
  treeNoticeSentence,
} from "@/features/draft-review/tree-line";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { tabLocation } from "@/features/project/context/identity-location";
import { deletedFromManuscriptSentence } from "@/features/project/context/RemovedDocumentNotice";
import { useRemovalRecord } from "@/features/project/context/use-removal-record";
import { cn } from "@/lib/utils";

export type ManuscriptState = {
  kind: "deleted" | "restored" | "pending-tree";
  sentence: string;
  label: string;
  dismiss?: () => void;
};

/** The document's manuscript state, or null when live did nothing to it. */
export function useManuscriptState(projectId: string, tab: ContextTab): ManuscriptState | null {
  useLingui();
  const { documentId } = tab;
  const { files } = useDraftReview();
  const owner = useDraftCommandOwner();
  const restored = useSyncExternalStore(
    owner.subscribe,
    () => owner.wasRestored(projectId, documentId),
    () => false,
  );
  useEffect(() => owner.keepRestoredOnly(projectId, documentId), [owner, projectId, documentId]);
  const item = files.find((file) => file.documentId === documentId)?.draft;
  const deleted = isDeletedFromManuscript(item);
  const removal = useRemovalRecord(projectId, deleted ? documentId : null);
  const title = tab.name;
  const hints = useDocumentDraftHints(projectId, documentId, { enabled: tab.kind !== "new" });
  if (deleted) {
    const sentence = deletedFromManuscriptSentence(
      title,
      removal?.kind === "removed" ? removal.record : null,
    );
    return { kind: "deleted", sentence, label: t`Deleted from the manuscript` };
  }
  if (restored)
    return {
      kind: "restored",
      sentence: restoredSentence([title]),
      label: t`Back in the manuscript`,
      dismiss: () => owner.forgetRestored(projectId, documentId),
    };
  const pending = hints.flatMap((hint): PendingTreeChange[] =>
    hint.tree ? [{ work: hint.label, line: hint.tree }] : [],
  );
  if (pending.length > 0) {
    const location = tabLocation(tab);
    const from = location.path ? { scheme: location.scheme, path: location.path } : null;
    return {
      kind: "pending-tree",
      sentence: pending.map((change) => treeNoticeSentence(change, from)).join(" "),
      label: treeNoticeLabel(pending, from),
    };
  }
  return null;
}

/**
 * The row's free end. Always rendered (it is the row's spacer), so a state that arrives fills
 * space the row already has.
 */
export function ManuscriptStateSlot({
  state,
  touch = false,
  className,
}: {
  state: ManuscriptState | null;
  touch?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("@container relative min-w-0 flex-1 self-stretch", className)}>
      {state ? (
        <div className="absolute inset-0 flex items-center">
          <ManuscriptStateChip state={state} touch={touch} />
        </div>
      ) : null}
    </div>
  );
}

function ManuscriptStateChip({ state, touch }: { state: ManuscriptState; touch: boolean }) {
  return (
    <div
      role="status"
      data-manuscript-state-notice={state.kind}
      className="flex min-w-0 max-w-full items-center font-sans text-ink-muted text-xs"
    >
      <Popover>
        <PopoverTrigger
          aria-label={state.sentence}
          title={state.sentence}
          className={cn(
            "focus-ring flex min-w-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-muted hover:text-foreground",
            touch ? "h-11" : "h-6 [@media(pointer:coarse)]:h-11",
          )}
        >
          <Info aria-hidden className="size-3.5 shrink-0" />
          <span aria-hidden className="min-w-0 truncate @max-[28rem]:hidden">
            {state.sentence}
          </span>
          <span aria-hidden className="hidden min-w-0 truncate @max-[28rem]:inline">
            {state.label}
          </span>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 max-w-[calc(100vw-1rem)] p-3 text-sm">
          {state.sentence}
        </PopoverContent>
      </Popover>
      {state.dismiss ? (
        <IconButton
          aria-label={t`Dismiss`}
          className={cn("shrink-0", touch ? "size-11" : "size-6 [@media(pointer:coarse)]:size-11")}
          onClick={state.dismiss}
        >
          <X aria-hidden className="size-3" />
        </IconButton>
      ) : null}
    </div>
  );
}
