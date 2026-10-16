import type { BranchStore } from "../domain/branch-coordinator.js";

export function unimplementedBranchMutations(): Pick<BranchStore, "commitBranchMutation"> {
  const missing = async (): Promise<never> => {
    throw new Error("This test store does not exercise atomic branch mutations");
  };
  return { commitBranchMutation: missing };
}
