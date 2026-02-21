import { useState } from "react";
import { X } from "lucide-react";
import { makeLogger } from "@/core/lib/logger";
import { Button } from "@/shared/components/ui/button";
import { useTreeSelection } from "../hooks/useTreeSelection";
import type { TreeNode } from "@/core/lib/treeBuilder";
import type {
  BulkOperation,
  OperationContext,
  OperationResult,
} from "../operations/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";

const log = makeLogger("batch-actions-bar");

/**
 * Follows SRP: only renders batch actions UI.
 * Follows DIP: depends on BulkOperation interface, not concrete implementations.
 */

interface BatchActionsBarProps {
  operations: BulkOperation[];
  selectedItems: TreeNode[];
  context: OperationContext;
  onComplete: () => void;
}

export function BatchActionsBar({
  operations,
  selectedItems,
  context,
  onComplete,
}: BatchActionsBarProps) {
  const { clearSelection } = useTreeSelection();
  const [isExecuting, setIsExecuting] = useState(false);
  const [confirmOperation, setConfirmOperation] =
    useState<BulkOperation | null>(null);
  const [lastResult, setLastResult] = useState<OperationResult | null>(null);

  const handleExecute = async (operation: BulkOperation) => {
    if (isExecuting) return;

    // Close confirmation dialog and clear previous result
    setConfirmOperation(null);
    setLastResult(null);

    setIsExecuting(true);

    try {
      // Execute with progress tracking
      const result = await operation.execute(selectedItems, {
        ...context,
        onProgress: () => {
          // Progress tracking happens here (could add UI feedback later)
        },
      });

      if (result.success) {
        // Operation completed successfully
        clearSelection();
        onComplete();
      } else {
        // Partial failure: show error, keep selection for retry
        setLastResult(result);
      }
    } catch (error) {
      // Unexpected error (not from operation.execute)
      log.error("Unexpected batch action error", error);
      setLastResult({
        success: false,
        successCount: 0,
        failedCount: selectedItems.length,
        errors: [
          error instanceof Error ? error.message : "Unexpected error occurred",
        ],
      });
    } finally {
      setIsExecuting(false);
    }
  };

  const handleOperationClick = (operation: BulkOperation) => {
    // For destructive operations, show confirmation dialog
    if (operation.variant === "destructive") {
      setConfirmOperation(operation);
    } else {
      handleExecute(operation);
    }
  };

  if (selectedItems.length === 0) return null;

  return (
    <>
      <div className="bg-background/95 sticky bottom-0 z-10 flex items-center gap-2 border-t p-2 shadow-lg backdrop-blur-sm">
        {/* Close button */}
        <Button
          size="icon"
          variant="ghost"
          onClick={() => clearSelection()}
          disabled={isExecuting}
          aria-label="Clear selection"
        >
          <X className="size-3.5" />
        </Button>

        {/* Count */}
        <span className="text-xs font-medium">
          {selectedItems.length} selected
        </span>

        {/* Separator */}
        <div className="flex-1" />

        {/* Error display for partial failures */}
        {lastResult && !lastResult.success && (
          <span className="text-destructive text-xs">
            {lastResult.successCount} succeeded, {lastResult.failedCount} failed
          </span>
        )}

        {/* Action buttons */}
        {operations.map((op) => (
          <Button
            key={op.id}
            size="sm"
            variant={op.variant}
            onClick={() => handleOperationClick(op)}
            disabled={!op.canExecute(selectedItems) || isExecuting}
          >
            {op.icon}
            {op.label}
          </Button>
        ))}
      </div>

      {/* Confirmation dialog for destructive operations */}
      {confirmOperation && (
        <Dialog
          open={!!confirmOperation}
          onOpenChange={(open) => !open && setConfirmOperation(null)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {confirmOperation.label} {selectedItems.length} items?
              </DialogTitle>
              <DialogDescription>
                This action cannot be undone. This will permanently delete:
                <ul className="mt-2 max-h-32 list-inside list-disc overflow-y-auto">
                  {selectedItems.slice(0, 10).map((item) => (
                    <li key={item.id} className="truncate text-sm">
                      {item.name}
                    </li>
                  ))}
                  {selectedItems.length > 10 && (
                    <li className="text-muted-foreground text-sm">
                      ...and {selectedItems.length - 10} more
                    </li>
                  )}
                </ul>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmOperation(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => handleExecute(confirmOperation)}
              >
                {confirmOperation.label}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
