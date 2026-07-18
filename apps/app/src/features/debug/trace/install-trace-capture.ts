/** Installs dev-only client trace capture before either socket transport is created. */

import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { setYjsWireTap } from "@/core/transport/tapped-websocket";
import { setThreadWireTap } from "@/core/transport/wire-tap";

import { meridianTraceAPI } from "./agent-trace-api";
import {
  createThreadWireTap,
  createThreadWireTapState,
  type ThreadWireTapState,
} from "./thread-wire-tap";
import { appendTraceEvent, noteTapError } from "./trace-store";
import { createYjsWireTap, createYjsWireTapState, type YjsWireTapState } from "./yjs-wire-tap";

type HotData = {
  threadWireTapState?: ThreadWireTapState;
  yjsWireTapState?: YjsWireTapState;
};

export function installTraceCapture(): void {
  if (!DEBUG_FEATURE_ALLOWED) return;

  if (typeof window !== "undefined") window.__meridianTrace = meridianTraceAPI;

  const hotData = import.meta.hot?.data as HotData | undefined;
  const threadState = hotData?.threadWireTapState ?? createThreadWireTapState();
  const yjsState = hotData?.yjsWireTapState ?? createYjsWireTapState();
  if (hotData) {
    hotData.threadWireTapState = threadState;
    hotData.yjsWireTapState = yjsState;
  }

  setThreadWireTap(createThreadWireTap(appendTraceEvent, noteTapError, threadState));
  setYjsWireTap(createYjsWireTap(appendTraceEvent, noteTapError, yjsState));
}
