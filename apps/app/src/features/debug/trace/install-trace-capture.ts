// Install trace capture before the thread and room sockets are created, or early frames are missed.

import { appendTraceEvent, noteTapError } from "@/client/trace-store";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { setLoroWireTap, setThreadWireTap } from "@/core/transport/wire-tap";
import { meridianTraceAPI } from "./agent-trace-api";
import { createLoroWireTap, createLoroWireTapState, type LoroWireTapState } from "./loro-wire-tap";
import {
  createThreadWireTap,
  createThreadWireTapState,
  type ThreadWireTapState,
} from "./thread-wire-tap";

type HotData = {
  threadWireTapState?: ThreadWireTapState;
  loroWireTapState?: LoroWireTapState;
};

export function installTraceCapture(): void {
  if (!DEBUG_FEATURE_ALLOWED) return;

  if (typeof window !== "undefined") window.__meridianTrace = meridianTraceAPI;

  const hotData = import.meta.hot?.data as HotData | undefined;
  const threadState = hotData?.threadWireTapState ?? createThreadWireTapState();
  const loroState = hotData?.loroWireTapState ?? createLoroWireTapState();
  if (hotData) {
    hotData.threadWireTapState = threadState;
    hotData.loroWireTapState = loroState;
  }

  setThreadWireTap(createThreadWireTap(appendTraceEvent, noteTapError, threadState));
  setLoroWireTap(createLoroWireTap(appendTraceEvent, noteTapError, loroState));
}
