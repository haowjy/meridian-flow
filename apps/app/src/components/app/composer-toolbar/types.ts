import type { ReactNode, RefObject } from "react";

export type ComposerControlId = string;
export type ComposerToolbarInlineContext = {
  open: boolean;
  busy: boolean;
  requestOpen(): void;
  requestDismiss(): void;
};
export type ComposerToolbarPanelContext = { host: "inline" | "overflow"; requestDismiss(): void };
export type ComposerToolbarPanel = {
  open: boolean;
  busy: boolean;
  canDismiss: boolean;
  ariaLabel: string;
  size: "compact" | "picker";
  initialFocusRef?: RefObject<HTMLElement | null>;
  onRequestOpen(): void;
  onRequestDismiss(): void;
  render(context: ComposerToolbarPanelContext): ReactNode;
};
export type ComposerToolbarOverflowItem = {
  ariaLabel: string;
  label: ReactNode;
  value?: ReactNode;
  icon?: ReactNode;
};
export type ComposerToolbarOverflow =
  | { kind: "status"; item: ComposerToolbarOverflowItem }
  | { kind: "panel"; item: ComposerToolbarOverflowItem; panel: ComposerToolbarPanel };
export type ComposerToolbarControl = {
  id: ComposerControlId;
  priority: number;
  inline(context: ComposerToolbarInlineContext): ReactNode;
  overflow: ComposerToolbarOverflow;
};
