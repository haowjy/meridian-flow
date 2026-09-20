/**
 * Child report delivery port: a durable obligation to surface a background
 * child's terminal report to its parent, written atomically with the child's
 * terminal lifecycle and driven to exactly-once delivery by the sweep.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SpawnResult } from "@meridian/contracts/spawn";

export interface ChildReportEnqueue {
  reportId: TurnId;
  parentThreadId: ThreadId;
  childThreadId: ThreadId;
  agentSlug: string;
  description?: string;
  result: SpawnResult;
  systemTurnId?: TurnId;
}

export interface ChildReportDelivery {
  enqueue(input: ChildReportEnqueue): Promise<void>;
  flush(parentThreadId: ThreadId): Promise<void>;
  sweep(): Promise<void>;
}
