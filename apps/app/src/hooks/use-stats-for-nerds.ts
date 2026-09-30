/** useStatsForNerds — subscribes a component to the device's "Stats for nerds" preference. */
import { useSyncExternalStore } from "react";

import { resolveStatsForNerds, subscribeStatsForNerds } from "@/lib/stats-for-nerds";

export function useStatsForNerds(): boolean {
  return useSyncExternalStore(subscribeStatsForNerds, resolveStatsForNerds, () => false);
}
