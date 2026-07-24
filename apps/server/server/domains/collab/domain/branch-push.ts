/** Public facade for branch push operations. */
import type { BranchPushExecutorInput, BranchPushService } from "./branch-push-contracts.js";
import { createBranchPushExecutor } from "./branch-push-executor.js";

export function createBranchPushService(input: BranchPushExecutorInput): BranchPushService {
  return createBranchPushExecutor(input);
}
