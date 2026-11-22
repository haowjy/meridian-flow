/** Installs dev-only client trace capture before the thread socket is created. */

import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { setThreadWireTap } from "@/core/transport/wire-tap";

import { meridianTraceAPI } from "./agent-trace-api";
import {
  createThreadWireTap,
  createThreadWireTapState,
  type ThreadWireTapState,
} from "./thread-wire-tap";
import { appendTraceEvent, noteTapError } from "./trace-store";

type HotData = {
  threadWireTapState?: ThreadWireTapState;
};

export function installTraceCapture(): void {
  if (!DEBUG_FEATURE_ALLOWED) return;

  if (typeof window !== "undefined") window.__meridianTrace = meridianTraceAPI;

  const hotData = import.meta.hot?.data as HotData | undefined;
  const threadState = hotData?.threadWireTapState ?? createThreadWireTapState();
  if (hotData) {
    hotData.threadWireTapState = threadState;
  }

  setThreadWireTap(createThreadWireTap(appendTraceEvent, noteTapError, threadState));
}
