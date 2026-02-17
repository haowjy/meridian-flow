import { useMemo, useState } from "react";
import type { Proposal, ProposalReviewModel } from "@meridian/cm6-collab";
import { ScrollArea } from "@/shared/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { cn } from "@/lib/utils";
import { AIProposalReviewDiff } from "./AIProposalReviewDiff";
import { AIProposalReviewActions } from "./AIProposalReviewActions";

interface AIProposalReviewPanelProps {
  proposals: Map<string, Proposal>;
  reviewModels: Map<string, ProposalReviewModel>;
  onAcceptProposal: (proposalId: string) => void;
  onRejectProposal: (proposalId: string) => void;
}

export function sortPendingProposals(proposals: Iterable<Proposal>): Proposal[] {
  return Array.from(proposals).sort((left, right) => {
    const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }

    return left.id.localeCompare(right.id);
  });
}

export function resolveSelectedProposalId(
  currentProposalId: string | null,
  sortedProposals: Proposal[],
): string | null {
  if (sortedProposals.length === 0) {
    return null;
  }

  if (currentProposalId == null) {
    return sortedProposals[0]?.id ?? null;
  }

  if (sortedProposals.some((proposal) => proposal.id === currentProposalId)) {
    return currentProposalId;
  }

  return sortedProposals[0]?.id ?? null;
}

export function invokeSelectedProposalAction(
  selectedProposalId: string | null,
  action: (proposalId: string) => void,
): boolean {
  if (selectedProposalId == null) {
    return false;
  }

  action(selectedProposalId);
  return true;
}

export function AIProposalReviewPanel({
  proposals,
  reviewModels,
  onAcceptProposal,
  onRejectProposal,
}: AIProposalReviewPanelProps) {
  const sortedProposals = useMemo(() => {
    return sortPendingProposals(proposals.values());
  }, [proposals]);

  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const resolvedSelectedProposalId = useMemo(() => {
    return resolveSelectedProposalId(selectedProposalId, sortedProposals);
  }, [selectedProposalId, sortedProposals]);

  const selectedReview =
    resolvedSelectedProposalId == null
      ? null
      : (reviewModels.get(resolvedSelectedProposalId) ?? null);

  if (sortedProposals.length === 0) {
    return null;
  }

  return (
    <Card className="mx-3 mt-2 overflow-hidden">
      <CardHeader className="py-2">
        <CardTitle className="text-sm">AI Proposals ({sortedProposals.length})</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-0 p-0 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <ScrollArea className="border-r">
          <div className="flex flex-col p-1">
            {sortedProposals.map((proposal) => {
              const isSelected = proposal.id === resolvedSelectedProposalId;
              return (
                <button
                  key={proposal.id}
                  type="button"
                  className={cn(
                    "rounded-md px-2 py-1.5 text-left transition-colors",
                    isSelected
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted text-foreground",
                  )}
                  onClick={() => setSelectedProposalId(proposal.id)}
                >
                  <p className="truncate text-xs font-medium">{proposal.description ?? proposal.id}</p>
                  <p className="text-muted-foreground truncate text-[11px]">{proposal.createdAt}</p>
                </button>
              );
            })}
          </div>
        </ScrollArea>

        <div className="flex min-h-52 flex-col">
          <div className="min-h-0 flex-1">
            <AIProposalReviewDiff reviewModel={selectedReview} />
          </div>
          <AIProposalReviewActions
            disabled={resolvedSelectedProposalId == null}
            onAccept={() => {
              invokeSelectedProposalAction(resolvedSelectedProposalId, onAcceptProposal);
            }}
            onReject={() => {
              invokeSelectedProposalAction(resolvedSelectedProposalId, onRejectProposal);
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
