/** Work mutations record refresh notices in their business transaction. */
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import type { WorkContextUpdateStatus } from "@meridian/contracts/works";
export interface WorkContextNotices {
  projectChanged(projectId: ProjectId): Promise<void>;
  threadChanged(threadId: ThreadId): Promise<void>;
  materializeIdle(threadId: ThreadId): Promise<Exclude<WorkContextUpdateStatus, "not_required">>;
  sweepWorkNotices(): Promise<number>;
}
