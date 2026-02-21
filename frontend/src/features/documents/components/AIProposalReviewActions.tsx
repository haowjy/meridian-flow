import { Button } from "@/shared/components/ui/button";

interface AIProposalReviewActionsProps {
  disabled: boolean;
  onAccept: () => void;
  onReject: () => void;
}

export function AIProposalReviewActions({
  disabled,
  onAccept,
  onReject,
}: AIProposalReviewActionsProps) {
  return (
    <div className="flex items-center justify-end gap-2 border-t px-3 py-2">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={onReject}
      >
        Reject All
      </Button>
      <Button size="sm" disabled={disabled} onClick={onAccept}>
        Accept All
      </Button>
    </div>
  );
}
