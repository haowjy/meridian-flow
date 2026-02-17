/**
 * ProposalStatusBadge - Shows collab proposal status on edit tool results.
 *
 * Displayed when the backend creates a collab proposal for an edit operation.
 * Uses semantic colors consistent with the rest of the badge system:
 * - Pending (yellow/warning): proposal awaiting human review
 * - Accepted (green/success): auto-accepted or accepted by reviewer
 * - Resolved (muted): proposal was accepted/rejected and removed from queue
 */

import { cn } from "@/lib/utils";
import type { ProposalBadgeStatus } from "@/features/documents/hooks/useProposalStatus";

const STATUS_CONFIG: Record<
  NonNullable<ProposalBadgeStatus>,
  { label: string; classes: string }
> = {
  pending: {
    label: "Pending Review",
    classes: "bg-warning/15 text-warning border-warning/30",
  },
  accepted: {
    label: "Accepted",
    classes: "bg-success/15 text-success border-success/30",
  },
  resolved: {
    label: "Reviewed",
    classes: "bg-muted text-muted-foreground border-muted-foreground/30",
  },
};

interface ProposalStatusBadgeProps {
  status: ProposalBadgeStatus;
}

export function ProposalStatusBadge({ status }: ProposalStatusBadgeProps) {
  if (!status) return null;

  const config = STATUS_CONFIG[status];

  return (
    <span
      className={cn(
        "shrink-0 text-[11px] font-medium",
        "rounded-full border px-2 py-0.5",
        config.classes,
      )}
    >
      {config.label}
    </span>
  );
}
