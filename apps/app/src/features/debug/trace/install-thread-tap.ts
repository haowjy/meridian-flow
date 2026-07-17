/** Installs dev-only thread WebSocket capture before the transport is created. */

import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { setThreadWireTap } from "@/core/transport/tapped-websocket";

import {
  createThreadWireTap,
  createThreadWireTapState,
  type ThreadWireTapState,
} from "./thread-wire-tap";
import { appendTraceEvent, noteTapError } from "./trace-store";

type HotData = {
  threadWireTapState?: ThreadWireTapState;
};

export function installThreadTap(): void {
  if (!DEBUG_FEATURE_ALLOWED) return;

  const hotData = import.meta.hot?.data as HotData | undefined;
  const state = hotData?.threadWireTapState ?? createThreadWireTapState();
  if (hotData) hotData.threadWireTapState = state;

  setThreadWireTap(createThreadWireTap(appendTraceEvent, noteTapError, state));
}
