/** React adapter for the dev-only trace store; inline English is intentional. */
import { useSyncExternalStore } from "react";

import { getTraceSnapshot, subscribeToTraceStore } from "./trace-store";

export function useTraceStore() {
  return useSyncExternalStore(subscribeToTraceStore, getTraceSnapshot, getTraceSnapshot);
}
