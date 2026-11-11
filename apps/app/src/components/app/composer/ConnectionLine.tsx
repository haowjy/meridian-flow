import { Trans } from "@lingui/react/macro";
import type { ConnectionState } from "@meridian/thread-client";
import { useEffect, useState } from "react";
import {
  connectionTrouble,
  useOptionalThreadTransport,
} from "@/client/providers/TransportProvider";
import { Button } from "@/components/ui/button";

/**
 * The chat connection's state inside the composer, where sending is what it affects. Says
 * nothing while connected. Not a live region: TransportProvider announces the change once,
 * however many composers are on screen.
 */
export function ConnectionLine() {
  const transport = useOptionalThreadTransport();
  const [state, setState] = useState<ConnectionState | null>(null);
  useEffect(() => transport?.onConnectionState(setState), [transport]);

  const trouble = state && connectionTrouble(state);
  if (!transport || !trouble) return null;
  return (
    <div className="mt-[var(--chat-space-inline)] flex items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      <span className="min-w-0 truncate">{trouble}</span>
      <Button
        type="button"
        variant="quiet"
        size="meta"
        className="-my-1 shrink-0 text-jade-text"
        onClick={() => transport.reconnect()}
      >
        <Trans>Reconnect now</Trans>
      </Button>
    </div>
  );
}
