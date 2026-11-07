/** The five pending-root rules. Historical creation is not evidence of current catalog liveness. */
import type { ImportSummary } from "@meridian/contracts";
export type PendingRootMemory = { seen: boolean; drawn: boolean; deadline?: number };
export function pendingRoot(
  summary: ImportSummary,
  memory: PendingRootMemory,
  catalogHolds: boolean,
  now: number,
  reading = false,
) {
  if (!summary.root) return { draw: false, memory };
  if (catalogHolds) return { draw: false, memory: { ...memory, seen: true } };
  if (memory.seen) return { draw: false, memory };
  if (
    !summary.root.created &&
    (reading || summary.state === "uploading" || summary.state === "organizing")
  )
    return { draw: true, memory: { ...memory, drawn: true } };
  if (summary.root.created && memory.drawn) {
    const deadline = memory.deadline ?? now + 30000;
    return { draw: now < deadline, memory: { ...memory, deadline } };
  }
  return { draw: false, memory };
}
