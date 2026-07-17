/**
 * Installs client Yjs wire capture for the dev-only debug overlay lifecycle.
 * i18n exception: this build-gated debug feature uses inline English by design.
 */
import { useEffect } from "react";

import { setYjsWireTap } from "@/core/transport/tapped-websocket";

import { appendTraceEvent, noteTapError } from "./trace-store";
import { createYjsWireTap } from "./yjs-wire-tap";

export function YjsWireTapInstaller() {
  useEffect(() => {
    setYjsWireTap(createYjsWireTap(appendTraceEvent, noteTapError));
    return () => setYjsWireTap(null);
  }, []);

  return null;
}
