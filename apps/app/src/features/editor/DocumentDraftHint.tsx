/**
 * DocumentDraftHint — a line under the identity row saying that drafts other than the one
 * this view works in have changes to the open document, with a Review action that opens that
 * draft's review. One draft: its label and Review. Several: a count and a short list.
 * Renders nothing when there are none, so a document no draft touches shows no hint.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronDown } from "lucide-react";
import { useDocumentDraftHints } from "@/client/query/useDocumentDraftHints";
import type { ContextTab } from "@/client/stores";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { tabLocation } from "@/features/project/context/identity-location";
import { useAiDraftLauncher } from "@/features/project/dock/useAiDraftLauncher";
import { draftsOtherThanViews, hintReviewTarget } from "./draft-hint-review";

export type DocumentDraftHintProps = {
  projectId: string;
  /** The open document's tab; a local reservation (`new`) has no drafts to find. */
  tab: ContextTab;
};

const REVIEW_CLASS =
  "focus-ring inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium text-jade-text hover:bg-primary/10 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-2.5";

export function DocumentDraftHint({ projectId, tab }: DocumentDraftHintProps) {
  const { documentId } = tab;
  const location = tabLocation(tab);
  const contextLocation = location.path ? { scheme: location.scheme, path: location.path } : null;
  const documentName = location.leaf;
  const { controller } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();
  const hints = useDocumentDraftHints(projectId, documentId, { enabled: tab.kind !== "new" });
  const others = draftsOtherThanViews(hints, controller.workId);
  if (!contextLocation || others.length === 0) return null;

  const review = (hint: (typeof others)[number]) => {
    const target = hintReviewTarget(hint, { documentId, contextLocation, documentName });
    if (target) openAiDraft(target);
  };
  const labelOf = (hint: (typeof others)[number]) => hint.label ?? t`Unnamed draft`;
  const [only] = others;

  return (
    <div
      data-document-draft-hint
      className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 px-4 font-sans text-ink-muted text-sm [@media(pointer:coarse)]:min-h-11"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
      <span className="min-w-0">
        {others.length === 1 && only ? (
          only.label ? (
            <Trans>A draft has changes to this ({only.label})</Trans>
          ) : (
            <Trans>A draft has changes to this</Trans>
          )
        ) : (
          plural(others.length, { other: "# drafts have changes to this" })
        )}
      </span>
      {others.length === 1 && only ? (
        <button type="button" className={REVIEW_CLASS} onClick={() => review(only)}>
          <Trans>Review</Trans>
        </button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger className={REVIEW_CLASS}>
            <Trans>Review</Trans>
            <ChevronDown aria-hidden className="size-3 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[min(18rem,calc(100vw-1rem))]">
            {others.map((hint) => (
              <DropdownMenuItem key={hint.draftId} onSelect={() => review(hint)}>
                {labelOf(hint)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
