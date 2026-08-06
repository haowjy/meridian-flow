/** Port through which Work commands refresh model-visible Work context. */
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";

export interface WorkContextUpdates {
  projectChanged(projectId: ProjectId): Promise<void>;
  threadChanged(threadId: ThreadId): Promise<void>;
}

export const noopWorkContextUpdates: WorkContextUpdates = {
  async projectChanged() {},
  async threadChanged() {},
};
