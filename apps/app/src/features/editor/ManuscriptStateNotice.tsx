import { useLingui } from "@lingui/react";
import { Info } from "lucide-react";
import { useDocumentDraftHints } from "@/client/query/useDocumentDraftHints";
import type { OpenDocument } from "@/client/stores";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  type PendingTreeChange,
  treeNoticeLabel,
  treeNoticeSentence,
} from "@/features/draft-review/tree-line";
import { tabLocation } from "@/features/project/context/identity-location";
import { useShellTreeVersion } from "@/features/project/tree-version";
import { cn } from "@/lib/utils";

export type ManuscriptState = {
  kind: "pending-tree";
  label: string;
  sentence?: string;
};

export function useManuscriptState(projectId: string, tab: OpenDocument): ManuscriptState | null {
  useLingui();
  const { documentId } = tab;
  const hints = useDocumentDraftHints(projectId, documentId, { enabled: tab.kind !== "new" });
  // On Draft the page is the toggle's Work's draft: this says what other Works do.
  const shell = useShellTreeVersion();
  const shown = shell?.showing === "draft" ? shell.draftId : null;
  const pending = hints.flatMap((hint): PendingTreeChange[] =>
    hint.tree && hint.draftId !== shown ? [{ work: hint.label, line: hint.tree }] : [],
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
  const hidden = state.sentence ? true : undefined;
  const content = (
    <>
      <Info aria-hidden className="size-3.5 shrink-0" />
      <span aria-hidden={hidden} className="min-w-0 truncate @max-[28rem]:hidden">
        {state.sentence ?? state.label}
      </span>
      <span aria-hidden={hidden} className="hidden min-w-0 truncate @max-[28rem]:inline">
        {state.label}
      </span>
    </>
  );
  const height = touch ? "h-11" : "h-6 coarse:h-11";
  return (
    <div
      role="status"
      data-manuscript-state-notice={state.kind}
      className="flex min-w-0 max-w-full items-center font-sans text-muted-foreground text-xs"
    >
      {state.sentence ? (
        <Popover>
          <PopoverTrigger
            aria-label={state.sentence}
            title={state.sentence}
            className={cn(
              "focus-ring flex min-w-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-ink-fill hover:text-foreground",
              height,
            )}
          >
            {content}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 max-w-[calc(100vw-1rem)] p-3 text-sm">
            {state.sentence}
          </PopoverContent>
        </Popover>
      ) : (
        <span className={cn("flex min-w-0 items-center gap-1.5 px-1.5", height)}>{content}</span>
      )}
    </div>
  );
}
