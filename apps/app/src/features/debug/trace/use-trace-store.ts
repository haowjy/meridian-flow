import { useSyncExternalStore } from "react";

import { getTraceSnapshot, subscribeToTraceStore } from "@/client/trace-store";

export function useTraceStore() {
  return useSyncExternalStore(subscribeToTraceStore, getTraceSnapshot, getTraceSnapshot);
}
