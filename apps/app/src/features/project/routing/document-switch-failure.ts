/** Failure presentation only for an explicit rail switch or dock-header Editor jump. */
import { useEffect, useState } from "react";
import type { ScreenKey } from "../shell/screens";
import type { NavigationSettlement, ProjectNavigationTicket } from "./project-navigation";

export type RunDocumentSwitch = (
  operation: (onAccepted: () => void) => Promise<NavigationSettlement> | Promise<void>,
  onSourceFailure: () => void,
) => Promise<void>;

export async function runDocumentSwitch(
  operation: (onAccepted: () => void) => Promise<NavigationSettlement> | Promise<void>,
  ports: {
    isCurrent: (ticket: ProjectNavigationTicket) => boolean;
    onDestinationFailure: () => void;
  },
  onSourceFailure: () => void,
): Promise<void> {
  let accepted = false;
  const present = () => {
    if (accepted) ports.onDestinationFailure();
    else onSourceFailure();
  };
  try {
    const result = await operation(() => {
      accepted = true;
    });
    if (result?.kind === "failed" && ports.isCurrent(result.ticket)) present();
  } catch {
    // Navigation commands reject only genuine failures; cancel/supersede settle normally.
    present();
  }
}

/** Inline rail feedback belongs to the source location, not to the screen kind. */
export function useRailSwitchFailure(entryKey: string, screen: ScreenKey) {
  const [failed, setFailed] = useState<ScreenKey | null>(null);
  useEffect(() => setFailed(null), [entryKey, screen]);
  return [failed, setFailed] as const;
}
