/** Installs dev-only Yjs capture before the first document transport is created. */
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { setYjsWireTap } from "@/core/transport/tapped-websocket";

import { meridianTraceAPI } from "./agent-trace-api";
import { appendTraceEvent, noteTapError } from "./trace-store";
import { createYjsWireTap, createYjsWireTapState, type YjsWireTapState } from "./yjs-wire-tap";

type HotData = {
  yjsWireTapState?: YjsWireTapState;
};

export function installYjsTap(): void {
  if (!DEBUG_FEATURE_ALLOWED) return;

  if (typeof window !== "undefined") window.__meridianTrace = meridianTraceAPI;

  const hotData = import.meta.hot?.data as HotData | undefined;
  const state = hotData?.yjsWireTapState ?? createYjsWireTapState();
  if (hotData) hotData.yjsWireTapState = state;

  setYjsWireTap(createYjsWireTap(appendTraceEvent, noteTapError, state));
}
