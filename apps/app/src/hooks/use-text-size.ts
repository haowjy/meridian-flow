/**
 * useTextSize — subscribes settings UI to the local reading-size preference.
 */
import { useSyncExternalStore } from "react";

import { DEFAULT_TEXT_SIZE, resolveTextSize, subscribeTextSize } from "@/lib/text-size";

export function useTextSize() {
  return useSyncExternalStore(subscribeTextSize, resolveTextSize, () => DEFAULT_TEXT_SIZE);
}
