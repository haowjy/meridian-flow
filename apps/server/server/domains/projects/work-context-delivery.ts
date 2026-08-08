/** Deep port for durable Work-context notification, delivery, and recovery. */
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import type { Block, OrchestratorEvent, Turn } from "@meridian/contracts/threads";
import type { WorkContextUpdateStatus } from "@meridian/contracts/works";

export type WorkContextPostCommitResult = Exclude<WorkContextUpdateStatus, "not_required">;

export interface DeliveredWorkContextUpdate {
  turn: Turn;
  block: Block;
  events: OrchestratorEvent[];
}

export interface WorkContextDelivery {
  projectChanged(projectId: ProjectId): Promise<void>;
  threadChanged(threadId: ThreadId): Promise<void>;
  deliverAfterCommit(threadId: ThreadId): Promise<WorkContextPostCommitResult>;
  beforeTurn(threadId: ThreadId): Promise<void>;
  flushOwned(threadId: ThreadId): Promise<void>;
  deliverNow(threadId: ThreadId): Promise<DeliveredWorkContextUpdate>;
  sweep(): Promise<void>;
}
