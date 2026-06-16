/**
 * TransportSection — surfaces the WS singleton's `ConnectionState` union.
 *
 * Key decisions:
 * - Subscribes via `useThreadTransport().onConnectionState(cb)`. The transport
 *   emits the current state synchronously on subscribe, so initial render gets
 *   real data without a manual probe.
 * - Read-only: never calls `connect`/`disconnect`/`reconnect`.
 * - i18n exception: DEV-only debug surface; bypasses Lingui.
 */
import { useEffect, useState } from "react";

import { useThreadTransport } from "@/client/providers/TransportProvider";
import type { ConnectionState } from "@/core/transport";

import { JsonTree } from "../JsonTree";

/**
 * Live `ConnectionState` from the WS singleton. The transport emits the current
 * state synchronously on subscribe, so the first render already has real data.
 * Shared by the section body and the pill's collapsed header chip.
 */
export function useConnectionState(): ConnectionState | null {
  const transport = useThreadTransport();
  const [state, setState] = useState<ConnectionState | null>(null);
  useEffect(() => transport.onConnectionState((next) => setState(next)), [transport]);
  return state;
}

export function TransportSection() {
  const state = useConnectionState();

  if (!state) {
    return <p className="text-meta text-muted-foreground">No connection state received yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-foreground">
        kind: <span className="font-mono">{state.kind}</span>
      </div>
      <JsonTree value={state} />
    </div>
  );
}
