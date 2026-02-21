import { useMemo, useState } from "react";
import type {
  Proposal,
  ProposalOperationsModel,
} from "@meridian/cm6-collab";
import { ScrollArea } from "@/shared/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/core/stores/useUIStore";
import { AIProposalReviewDiff } from "./AIProposalReviewDiff";
import { AIProposalReviewActions } from "./AIProposalReviewActions";

interface AIProposalReviewPanelProps {
  proposals: Map<string, Proposal>;
  operationsModels: Map<string, ProposalOperationsModel>;
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
  operationsModels,
  onAcceptProposal,
  onRejectProposal,
}: AIProposalReviewPanelProps) {
  const sortedProposals = useMemo(() => {
    return sortPendingProposals(proposals.values());
  }, [proposals]);

  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);

  // Pending proposal ID from thread navigation ("View in Editor" action).
  // Acts as an override: if the pending proposal exists in the current list, select it.
  // Cleared when the user manually clicks a different proposal.
  const pendingProposalId = useUIStore((s) => s.pendingProposalId);

  const resolvedSelectedProposalId = useMemo(() => {
    // If a pending proposal ID is set and matches a current proposal, prefer it
    if (
      pendingProposalId &&
      sortedProposals.some((p) => p.id === pendingProposalId)
    ) {
      return pendingProposalId;
    }
    return resolveSelectedProposalId(selectedProposalId, sortedProposals);
  }, [selectedProposalId, sortedProposals, pendingProposalId]);

  const selectedOperationsModel =
    resolvedSelectedProposalId == null
      ? null
      : (operationsModels.get(resolvedSelectedProposalId) ?? null);

  // Chunk count badge: shown when operations model is ready with changes
  const getChunkCount = (proposalId: string): number | null => {
    const model = operationsModels.get(proposalId);
    if (model?.availability === "ready") return model.chunks.length;
    return null;
  };

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
              const chunkCount = getChunkCount(proposal.id);
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
                  onClick={() => {
                    setSelectedProposalId(proposal.id);
                    // Clear pending override so manual selection takes precedence
                    if (useUIStore.getState().pendingProposalId) {
                      useUIStore.getState().setPendingProposalId(null);
                    }
                  }}
                >
                  <p className="truncate text-xs font-medium">
                    {proposal.description ?? proposal.id}
                    {chunkCount !== null && chunkCount > 0 && (
                      <span className="text-muted-foreground ml-1.5 font-normal">
                        [{chunkCount} {chunkCount === 1 ? "chunk" : "chunks"}]
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground truncate text-[11px]">{proposal.createdAt}</p>
                </button>
              );
            })}
          </div>
        </ScrollArea>

        <div className="flex min-h-52 flex-col">
          <div className="min-h-0 flex-1">
            <AIProposalReviewDiff
              operationsModel={selectedOperationsModel}
              onAcceptChunk={() => {
                invokeSelectedProposalAction(resolvedSelectedProposalId, onAcceptProposal);
              }}
              onRejectChunk={() => {
                invokeSelectedProposalAction(resolvedSelectedProposalId, onRejectProposal);
              }}
            />
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
