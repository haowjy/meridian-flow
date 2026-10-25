/** The queued controls in a durable run-state record, shared by every client before local overlays. */
import type { ControlBody, PendingInboxItem } from "@meridian/contracts/threads";

export function durableControls(items: readonly PendingInboxItem[]) {
  return items.flatMap(
    (item): { id: string; control: ControlBody; status: "queued"; awaitsRun: boolean }[] =>
      item.intent === "control" && item.control
        ? [
            {
              id: item.id,
              control: item.control,
              status: "queued",
              awaitsRun: item.deliveryState === "awaiting_run",
            },
          ]
        : [],
  );
}
