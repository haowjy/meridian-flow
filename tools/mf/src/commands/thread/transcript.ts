/** Small shared readers for the thread commands: record narrowing, the live status label, and the `thread list` rows. */
import type { ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import type { Thread } from "@meridian/contracts/threads";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function liveStatusLabel(snapshot: Pick<ThreadSnapshotResponse, "liveState">): string {
  const status = snapshot.liveState.status;
  return status.kind === "asleep" ? "asleep" : `awake:${status.phase}`;
}

export type ThreadListRow = {
  id: string;
  ref: string | null;
  title: string | null;
  projectId: string;
  workId: string | null;
  agentName: string | null;
  turnCount: number;
  updatedAt: string;
};

export function threadListRow(thread: Thread): ThreadListRow {
  return {
    id: thread.id,
    ref: thread.ref,
    title: thread.title,
    projectId: thread.projectId,
    workId: thread.workId,
    agentName: thread.agentName,
    turnCount: thread.turnCount,
    updatedAt: thread.updatedAt,
  };
}

export function renderThreadList(rows: ThreadListRow[]): string {
  if (rows.length === 0) return "(no threads)";
  return rows
    .map(
      (row) =>
        `${row.id}  ${row.ref ?? "-"}  ${row.updatedAt}  turns=${row.turnCount}  ${row.agentName ?? "?"}  ${row.title ?? "(untitled)"}`,
    )
    .join("\n");
}
