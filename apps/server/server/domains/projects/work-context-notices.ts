/** Work mutations record refresh notices in their business transaction. */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { WorkContextUpdateStatus } from "@meridian/contracts/works";
/** The thread whose own tool call made a change already knows it, so it gets no notice. */
export interface WorkChangeOrigin {
  originThreadId?: ThreadId;
}

export interface WorkContextNotices {
  workChanged(workId: WorkId, origin?: WorkChangeOrigin): Promise<void>;
  threadChanged(threadId: ThreadId): Promise<void>;
  materializeIdle(threadId: ThreadId): Promise<Exclude<WorkContextUpdateStatus, "not_required">>;
  sweepWorkNotices(): Promise<number>;
}
