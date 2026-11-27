import type { ConnectionState } from "@meridian/thread-client";
import { useEffect, useState } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";

import { JsonTree } from "../JsonTree";

export function useConnectionState(): ConnectionState | null {
  const transport = useThreadTransport();
  const [state, setState] = useState<ConnectionState | null>(null);
  useEffect(() => transport.onConnectionState((next) => setState(next)), [transport]);
  return state;
}

export function TransportSection() {
  const state = useConnectionState();

  if (!state) {
    return <p className="text-xs text-muted-foreground">No connection state received yet.</p>;
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
