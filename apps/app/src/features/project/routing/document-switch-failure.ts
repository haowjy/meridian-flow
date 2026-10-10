/** Failure presentation only for an explicit rail switch or dock-header Editor jump. */
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
