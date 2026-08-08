import type { ReactNode } from "react";

export type ComposerControlId = string;

export type ComposerToolbarOverflow = {
  ariaLabel: string;
  label: ReactNode;
  value?: ReactNode;
  panel?: ReactNode;
  size?: "compact" | "picker";
  busy?: boolean;
  canDismiss?: boolean;
  onOpen?(): void;
  onBack?(): void;
};

export type ComposerToolbarControl = {
  id: ComposerControlId;
  priority: number;
  inline: ReactNode;
  overflow: ComposerToolbarOverflow;
};
