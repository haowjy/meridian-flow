import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  commitChunkEditSession,
  cancelChunkEditSession,
  startChunkEditSession,
  updateChunkEditSession,
} from "@meridian/cm6-collab";
import type {
  ChunkEditSession,
  Proposal,
  ProposalChunkResolutionStatus,
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
import { Button } from "@/shared/components/ui/button";
import { Textarea } from "@/shared/components/ui/textarea";
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
  applyChunkUpdate: (chunk: ReviewChunk, editedInsertedText?: string) => void;
}

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

type ProposalChunkResolutionMap = Map<
  string,
  Map<string, ProposalChunkResolutionStatus>
>;

interface ChunkEditState {
  chunk: ReviewChunk;
  /** Fingerprint stored at session-start so identity is stable even when chunk IDs shift after partial accepts. */
  fingerprint: string;
  session: ChunkEditSession;
}

const ACCEPTED_RESOLUTION_STATUSES: ProposalChunkResolutionStatus[] = [
  "accepted",
  "accepted_with_edits",
];

function isAcceptedResolutionStatus(
  status: ProposalChunkResolutionStatus | undefined,
): boolean {
  if (status == null) {
    return false;
  }
  return ACCEPTED_RESOLUTION_STATUSES.includes(status);
}

export function setChunkResolutionStatus(
  previous: ProposalChunkResolutionMap,
  proposalId: string,
  chunkKey: string,
  status: ProposalChunkResolutionStatus,
): ProposalChunkResolutionMap {
  const next = new Map(previous);
  const proposalResolutions = new Map(next.get(proposalId) ?? []);
  proposalResolutions.set(chunkKey, status);
  next.set(proposalId, proposalResolutions);
  return next;
}

export function countChunkResolutions(
  resolutions: Map<string, ProposalChunkResolutionStatus> | undefined,
): { acceptedCount: number; rejectedCount: number } {
  if (resolutions == null) {
    return { acceptedCount: 0, rejectedCount: 0 };
  }

  let acceptedCount = 0;
  let rejectedCount = 0;
  for (const status of resolutions.values()) {
    if (isAcceptedResolutionStatus(status)) {
      acceptedCount += 1;
      continue;
    }
    if (status === "rejected") {
      rejectedCount += 1;
    }
  }
  return { acceptedCount, rejectedCount };
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

  const [chunkResolutionMap, setChunkResolutionMap] =
    useState<ProposalChunkResolutionMap>(new Map());

  const [activeChunkEdit, setActiveChunkEdit] = useState<ChunkEditState | null>(
    null,
  );

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

  const filteredOpsModel: ProposalOperationsModel | null = useMemo(() => {
    if (
      selectedOperationsModel == null ||
      selectedOperationsModel.availability !== "ready"
    ) {
      return selectedOperationsModel;
    }
    const resolutions =
      chunkResolutionMap.get(resolvedSelectedProposalId ?? "") ?? new Map();
    if (resolutions.size === 0) {
      return selectedOperationsModel;
    }

    const visibleChunks = selectedOperationsModel.chunks.filter(
      (chunk) => resolutions.get(chunkFingerprint(chunk)) !== "rejected",
    );
    if (visibleChunks.length === selectedOperationsModel.chunks.length) {
      return selectedOperationsModel;
    }
    return { ...selectedOperationsModel, chunks: visibleChunks };
  }, [selectedOperationsModel, chunkResolutionMap, resolvedSelectedProposalId]);

  const getChunkCount = (proposalId: string): number | null => {
    const model = operationsModels.get(proposalId);
    if (model?.availability === "ready") return model.chunks.length;
    return null;
  };

  const finalizedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const [proposalId, resolutions] of chunkResolutionMap) {
      if (finalizedRef.current.has(proposalId)) continue;

      const { acceptedCount, rejectedCount } = countChunkResolutions(
        resolutions,
      );

      if (acceptedCount === 0 && rejectedCount === 0) {
        continue;
      }

      const model = operationsModels.get(proposalId);
      if (model == null || model.availability !== "ready") continue;

      if (model.chunks.length === 0 && acceptedCount > 0) {
        finalizedRef.current.add(proposalId);
        onRejectProposal(proposalId);
        continue;
      }

      if (rejectedCount > 0) {
        const pendingChunks = model.chunks.filter(
          (chunk) => resolutions.get(chunkFingerprint(chunk)) !== "rejected",
        );
        if (pendingChunks.length === 0) {
          finalizedRef.current.add(proposalId);
          onRejectProposal(proposalId);
        }
      }
    }
  }, [operationsModels, chunkResolutionMap, onRejectProposal]);

  const handleAcceptChunk = useCallback(
    (chunk: ReviewChunk) => {
      applyChunkUpdate(chunk);

      setChunkResolutionMap((previous) =>
        setChunkResolutionStatus(
          previous,
          chunk.proposalId,
          chunkFingerprint(chunk),
          "accepted",
        ),
      );
    },
    [applyChunkUpdate],
  );

  const handleRejectChunk = useCallback(
    (chunk: ReviewChunk) => {
      setChunkResolutionMap((previous) =>
        setChunkResolutionStatus(
          previous,
          chunk.proposalId,
          chunkFingerprint(chunk),
          "rejected",
        ),
      );
    },
    [],
  );

  const handleEditChunk = useCallback((chunk: ReviewChunk) => {
    setActiveChunkEdit({
      chunk,
      fingerprint: chunkFingerprint(chunk),
      session: startChunkEditSession(chunk),
    });
  }, []);

  const handleEditDraftChange = useCallback((nextDraft: string) => {
    setActiveChunkEdit((current) => {
      if (current == null) {
        return current;
      }
      return {
        ...current,
        session: updateChunkEditSession(current.session, nextDraft),
      };
    });
  }, []);

  const handleCancelChunkEdit = useCallback(() => {
    setActiveChunkEdit(() => cancelChunkEditSession());
  }, []);

  const effectiveActiveChunkEdit = useMemo(() => {
    if (activeChunkEdit == null) {
      return null;
    }

    if (resolvedSelectedProposalId !== activeChunkEdit.chunk.proposalId) {
      return null;
    }

    const model = operationsModels.get(activeChunkEdit.chunk.proposalId);
    if (model?.availability !== "ready") {
      return activeChunkEdit;
    }

    // Use fingerprint (not chunk.id) so identity is stable when chunk IDs
    // shift after other chunks are accepted/rejected concurrently.
    const isChunkStillPending = model.chunks.some(
      (chunk) => chunkFingerprint(chunk) === activeChunkEdit.fingerprint,
    );
    if (!isChunkStillPending) {
      return null;
    }

    return activeChunkEdit;
  }, [activeChunkEdit, operationsModels, resolvedSelectedProposalId]);

  const handleSaveEditedChunk = useCallback(() => {
    if (effectiveActiveChunkEdit == null) {
      return;
    }

    const commit = commitChunkEditSession(effectiveActiveChunkEdit.session);
    const resolutionStatus: ProposalChunkResolutionStatus = commit.wasEdited
      ? "accepted_with_edits"
      : "accepted";

    applyChunkUpdate(effectiveActiveChunkEdit.chunk, commit.insertedText);
    setChunkResolutionMap((previous) =>
      setChunkResolutionStatus(
        previous,
        effectiveActiveChunkEdit.chunk.proposalId,
        chunkFingerprint(effectiveActiveChunkEdit.chunk),
        resolutionStatus,
      ),
    );
    setActiveChunkEdit(() => cancelChunkEditSession());
  }, [effectiveActiveChunkEdit, applyChunkUpdate]);

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
              onEditChunk={handleEditChunk}
            />
          </div>
          {effectiveActiveChunkEdit && (
            <div className="bg-muted/30 border-t p-3">
              <p className="text-sm font-medium">Edit chunk before accepting</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Save applies only this chunk to the live document.
              </p>
              <Textarea
                value={effectiveActiveChunkEdit.session.draftInsertedText}
                onChange={(event) => handleEditDraftChange(event.target.value)}
                className="mt-2 min-h-24 text-sm"
                aria-label="Edit proposed chunk text"
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCancelChunkEdit}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSaveEditedChunk}>
                  Save & Accept
                </Button>
              </div>
            </div>
          )}
          <AIProposalReviewActions
            disabled={
              resolvedSelectedProposalId == null ||
              effectiveActiveChunkEdit != null
            }
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
