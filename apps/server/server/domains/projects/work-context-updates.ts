/**
 * Durable enqueue port for model-visible Work context refreshes.
 *
 * Mutation commands call this inside their business transaction. Delivery is
 * claimed separately and may fail without changing the committed outcome.
 */
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";

export interface WorkContextUpdates {
  projectChanged(projectId: ProjectId): Promise<void>;
  threadChanged(threadId: ThreadId): Promise<void>;
}

export const noopWorkContextUpdates: WorkContextUpdates = {
  async projectChanged() {},
  async threadChanged() {},
};
