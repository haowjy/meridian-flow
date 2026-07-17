/** Registers dev-only Yjs capture before the first document transport is created. */
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { setYjsWireTap } from "@/core/transport/tapped-websocket";

import { appendTraceEvent, noteTapError } from "./trace-store";
import { createYjsWireTap } from "./yjs-wire-tap";

if (DEBUG_FEATURE_ALLOWED) {
  // HMR can re-evaluate this module and reset observer state. A full reload
  // restores the page-lifetime sequence; that dev-only limitation is accepted.
  setYjsWireTap(createYjsWireTap(appendTraceEvent, noteTapError));
}
