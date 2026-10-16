/** Writer-row recovery commands produced by the submission model. */
import type { CommandFailure } from "@meridian/thread-client";

export type UserTurnRecovery = {
  failure?: CommandFailure;
  onRetry?: () => void;
  onEdit?: () => void;
  busy?: boolean;
  moving?: boolean;
};
