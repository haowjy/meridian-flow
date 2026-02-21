import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Proposal,
  ProposalOperationsModel,
  ReviewChunk,
} from "@meridian/cm6-collab";
import { ScrollArea } from "@/shared/components/ui/scroll-area";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/shared/components/ui/card";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/core/stores/useUIStore";
import { AIProposalReviewDiff } from "./AIProposalReviewDiff";
import { AIProposalReviewActions } from "./AIProposalReviewActions";

interface AIProposalReviewPanelProps {
  proposals: Map<string, Proposal>;
  operationsModels: Map<string, ProposalOperationsModel>;
  onAcceptProposal: (proposalId: string) => void;
  onRejectProposal: (proposalId: string) => void;
  /**
   * Apply a single chunk's edit to the live Y.Doc.
   * Called when user accepts a chunk in partial-accept mode.
   */
  applyChunkUpdate: (chunk: ReviewChunk) => void;
}

/**
 * Fingerprint for reject tracking: uses deletedText + insertedText as the
 * stable identity across re-derives. Positions shift after a partial apply,
 * but the text content of a chunk doesn't change.
 *
 * Collision risk: two chunks with identical deleted+inserted text would
 * collide. This is extremely unlikely in real prose editing and acceptable
 * for the current implementation.
 */
function chunkFingerprint(chunk: ReviewChunk): string {
  return `${chunk.deletedText}|||${chunk.insertedText}`;
}

export function sortPendingProposals(
  proposals: Iterable<Proposal>,
): Proposal[] {
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
  applyChunkUpdate,
}: AIProposalReviewPanelProps) {
  const sortedProposals = useMemo(() => {
    return sortPendingProposals(proposals.values());
  }, [proposals]);

  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(
    null,
  );

  // Per-proposal rejected chunk fingerprints: proposalId -> Set<fingerprint>.
  // Fingerprints survive re-derive because they use text content, not positions.
  const [rejectedFingerprints, setRejectedFingerprints] = useState<
    Map<string, Set<string>>
  >(new Map());

  // Track accepted chunk fingerprints per proposal for auto-finalization counting.
  const [acceptedFingerprints, setAcceptedFingerprints] = useState<
    Map<string, Set<string>>
  >(new Map());

  // Pending proposal ID from thread navigation ("View in Editor" action).
  // Acts as an override: if the pending proposal exists in the current list, select it.
  // Cleared when the user manually clicks a different proposal.
  const pendingProposalId = useUIStore((s) => s.pendingProposalId);

  const proposalReviewMode = useUIStore((s) => s.proposalReviewMode);
  const toggleProposalReviewMode = useUIStore(
    (s) => s.toggleProposalReviewMode,
  );

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

  // Filter out rejected chunks from the selected model for display.
  // Accepted chunks disappear naturally via Y.Doc re-derive; rejected chunks
  // are hidden via fingerprint matching.
  const filteredOpsModel: ProposalOperationsModel | null = useMemo(() => {
    if (
      selectedOperationsModel == null ||
      selectedOperationsModel.availability !== "ready"
    ) {
      return selectedOperationsModel;
    }
    const rejected =
      rejectedFingerprints.get(resolvedSelectedProposalId ?? "") ?? new Set();
    if (rejected.size === 0) return selectedOperationsModel;
    const visibleChunks = selectedOperationsModel.chunks.filter(
      (c) => !rejected.has(chunkFingerprint(c)),
    );
    if (visibleChunks.length === selectedOperationsModel.chunks.length) {
      return selectedOperationsModel;
    }
    return { ...selectedOperationsModel, chunks: visibleChunks };
  }, [selectedOperationsModel, rejectedFingerprints, resolvedSelectedProposalId]);

  // Chunk count badge: shown when operations model is ready with changes
  const getChunkCount = (proposalId: string): number | null => {
    const model = operationsModels.get(proposalId);
    if (model?.availability === "ready") return model.chunks.length;
    return null;
  };

  // Ref to track which proposals have been auto-finalized to prevent double-finalize.
  const finalizedRef = useRef<Set<string>>(new Set());

  // Auto-finalization: when all chunks are resolved (accepted chunks disappear from
  // re-derived model, remaining are all rejected), close the proposal via server reject.
  // Uses useEffect watching operationsModels to ensure we have the LATEST model after
  // Y.Doc update triggers re-derive — not the snapshot at accept/reject time.
  //
  // Fingerprint cleanup is NOT done here to avoid calling setState in the effect.
  // Stale fingerprints for finalized proposals are harmless — the proposal will be
  // removed from the proposals map by the server's statusChanged event.
  useEffect(() => {
    // Collect all proposal IDs that have any chunk-level interaction
    const activeProposalIds = new Set<string>();
    for (const id of acceptedFingerprints.keys()) activeProposalIds.add(id);
    for (const id of rejectedFingerprints.keys()) activeProposalIds.add(id);

    for (const proposalId of activeProposalIds) {
      if (finalizedRef.current.has(proposalId)) continue;

      const acceptedSet = acceptedFingerprints.get(proposalId);
      const rejectedSet = rejectedFingerprints.get(proposalId);
      // Only auto-finalize if we've actually done some chunk-level work
      if (
        (!acceptedSet || acceptedSet.size === 0) &&
        (!rejectedSet || rejectedSet.size === 0)
      ) {
        continue;
      }

      const model = operationsModels.get(proposalId);
      if (model == null || model.availability !== "ready") continue;

      // Case 1: All accepted chunks absorbed — model re-derives to 0 chunks.
      if (model.chunks.length === 0 && acceptedSet && acceptedSet.size > 0) {
        finalizedRef.current.add(proposalId);
        onRejectProposal(proposalId);
        continue;
      }

      // Case 2: Remaining chunks are all rejected — none pending.
      if (rejectedSet && rejectedSet.size > 0) {
        const pendingChunks = model.chunks.filter(
          (c) => !rejectedSet.has(chunkFingerprint(c)),
        );
        if (pendingChunks.length === 0) {
          finalizedRef.current.add(proposalId);
          onRejectProposal(proposalId);
        }
      }
    }
  }, [operationsModels, acceptedFingerprints, rejectedFingerprints, onRejectProposal]);

  const handleAcceptChunk = useCallback(
    (chunk: ReviewChunk) => {
      if (resolvedSelectedProposalId == null) return;

      // Apply the chunk's edit to the live Y.Doc
      applyChunkUpdate(chunk);

      // Track accepted fingerprint for auto-finalization
      setAcceptedFingerprints((prev) => {
        const next = new Map(prev);
        const set = new Set(next.get(resolvedSelectedProposalId) ?? []);
        set.add(chunkFingerprint(chunk));
        next.set(resolvedSelectedProposalId, set);
        return next;
      });
      // Auto-finalization handled via useEffect watching operationsModels
    },
    [resolvedSelectedProposalId, applyChunkUpdate],
  );

  const handleRejectChunk = useCallback(
    (chunk: ReviewChunk) => {
      if (resolvedSelectedProposalId == null) return;

      setRejectedFingerprints((prev) => {
        const next = new Map(prev);
        const set = new Set(next.get(resolvedSelectedProposalId) ?? []);
        set.add(chunkFingerprint(chunk));
        next.set(resolvedSelectedProposalId, set);
        return next;
      });
      // Auto-finalization handled via useEffect watching operationsModels + rejectedFingerprints
    },
    [resolvedSelectedProposalId],
  );

  if (sortedProposals.length === 0) {
    return null;
  }

  return (
    <Card className="mx-3 mt-2 overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between py-2">
        <CardTitle className="text-sm">
          AI Proposals ({sortedProposals.length})
        </CardTitle>
        <button
          type="button"
          onClick={toggleProposalReviewMode}
          className="text-muted-foreground hover:text-foreground rounded p-1 text-xs transition-colors"
          title={
            proposalReviewMode === "unified"
              ? "Switch to side-by-side view"
              : "Switch to inline view"
          }
        >
          {proposalReviewMode === "unified" ? "⇔ Split" : "≡ Inline"}
        </button>
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
                  <p className="text-muted-foreground truncate text-[11px]">
                    {proposal.createdAt}
                  </p>
                </button>
              );
            })}
          </div>
        </ScrollArea>

        <div className="flex min-h-52 flex-col">
          <div className="min-h-0 flex-1">
            <AIProposalReviewDiff
              operationsModel={filteredOpsModel}
              mode={proposalReviewMode}
              onAcceptChunk={handleAcceptChunk}
              onRejectChunk={handleRejectChunk}
            />
          </div>
          <AIProposalReviewActions
            disabled={resolvedSelectedProposalId == null}
            onAccept={() => {
              invokeSelectedProposalAction(
                resolvedSelectedProposalId,
                onAcceptProposal,
              );
            }}
            onReject={() => {
              invokeSelectedProposalAction(
                resolvedSelectedProposalId,
                onRejectProposal,
              );
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
