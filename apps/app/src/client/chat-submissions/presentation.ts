/** Writer-row recovery commands produced by the submission model. */
export type UserTurnRecovery = {
  onRetry?: () => void;
  onEdit?: () => void;
  busy?: boolean;
};
