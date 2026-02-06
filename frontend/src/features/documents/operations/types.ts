import type { TreeNode } from "@/core/lib/treeBuilder";

/**
 * Strategy pattern for bulk operations.
 * Each operation implements this interface.
 * Follows OCP: add new operations without modifying existing code.
 */
export interface BulkOperation {
  id: string;
  label: string;
  icon: React.ReactNode;
  variant?: "default" | "destructive";

  // Can this operation run with current selection?
  canExecute(selectedItems: TreeNode[]): boolean;

  // Execute the operation
  execute(
    selectedItems: TreeNode[],
    context: OperationContext,
  ): Promise<OperationResult>;
}

export interface OperationContext {
  projectId: string;
  onProgress?: (current: number, total: number) => void;
  // Safe delete callbacks from useResourceOperations.
  // Handle navigation-away, cache cleanup, and retry cancellation.
  deleteDocument: (id: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
}

export interface OperationResult {
  success: boolean;
  successCount: number;
  failedCount: number;
  errors?: string[];
}
