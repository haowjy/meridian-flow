/** Work mutations record refresh notices in their business transaction. */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { WorkContextUpdateStatus } from "@meridian/contracts/works";
export interface WorkContextNotices {
  workChanged(workId: WorkId): Promise<void>;
  threadChanged(threadId: ThreadId): Promise<void>;
  materializeIdle(threadId: ThreadId): Promise<Exclude<WorkContextUpdateStatus, "not_required">>;
  sweepWorkNotices(): Promise<number>;
}
