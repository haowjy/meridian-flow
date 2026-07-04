/** DockedDraftReviewStack — one-line composer draft affordance for active drafts only. */
import { Trans } from "@lingui/react/macro";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { Button } from "@/components/ui/button";
import { DraftReviewCard } from "./DraftReviewCard";
import { activeDockedDraftGroups, dockedDraftCountKey } from "./docked-drafts";
import { useAiDraftLauncher } from "./useAiDraftLauncher";

export function DockedDraftReviewStack({ groups }: { groups: ThreadDraftGroup[] }) {
  const activeGroups = useMemo(() => activeDockedDraftGroups(groups), [groups]);
  const countKey = dockedDraftCountKey(activeGroups);
  const [expanded, setExpanded] = useState(false);
  const { openAiDraft } = useAiDraftLauncher();

  useEffect(() => {
    setExpanded(false);
  }, [countKey]);

  if (activeGroups.length === 0) return null;

  if (activeGroups.length === 1) {
    const [group] = activeGroups;
    return (
      <div data-unanchored-drafts>
        <DraftReviewCard group={group} variant="compact" />
      </div>
    );
  }

  const firstGroup = activeGroups[0];
  const firstDraft = firstGroup?.drafts[0] ?? null;

  return (
    <div data-unanchored-drafts className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-card px-3 py-1.5 shadow-xs">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
        <span className="min-w-0 truncate text-sm text-foreground">
          <Trans>{activeGroups.length} documents have AI changes</Trans>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => {
              if (firstGroup && firstDraft) openAiDraft(firstGroup, firstDraft.draftId);
            }}
          >
            <Trans>Review</Trans>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse AI draft rows" : "Expand AI draft rows"}
            onClick={() => setExpanded((value) => !value)}
            className="text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="size-4" aria-hidden />
            ) : (
              <ChevronRight className="size-4" aria-hidden />
            )}
          </Button>
        </div>
      </div>
      {expanded
        ? activeGroups.map((group) => (
            <DraftReviewCard key={group.documentId} group={group} variant="compact" />
          ))
        : null}
    </div>
  );
}
