/**
 * useSwitchAnnouncements — speaks a write-mode switch's queued and failed
 * states, read from the reconciled queued rows (a switch-back the client
 * predicts or the server confirms cancelled never reaches them, so it is
 * silent). The applied state is the divider's, announced with the other
 * dividers. Rows present at mount, and a row still sending, are silent.
 */
import { useEffect, useRef } from "react";
import { announce, announceError } from "@/client/stores";
import { controlStatusCopy } from "./control-copy";
import type { QueuedControl, QueuedControlStatus } from "./thread-controls";

export function useSwitchAnnouncements(queued: readonly QueuedControl[]): void {
  const seen = useRef<Map<string, QueuedControlStatus> | null>(null);
  useEffect(() => {
    const previous = seen.current;
    const statuses = new Map<string, QueuedControlStatus>();
    for (const row of queued) {
      if (row.control.kind !== "write_mode") continue;
      statuses.set(row.id, row.status);
      if (!previous || previous.get(row.id) === row.status) continue;
      if (row.status === "queued") announce(controlStatusCopy(row.control, "queued"));
      else if (row.status === "failed") announceError(controlStatusCopy(row.control, "failed"));
    }
    seen.current = statuses;
  }, [queued]);
}
