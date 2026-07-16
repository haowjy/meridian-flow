/** Public facade for branch push operations. */
import {
  type BranchPushExecutorInput,
  type BranchPushService,
  createBranchPushExecutor,
} from "./branch-push-executor.js";

export * from "./branch-push-executor.js";

export function createBranchPushService(input: BranchPushExecutorInput): BranchPushService {
  return createBranchPushExecutor(input);
}
