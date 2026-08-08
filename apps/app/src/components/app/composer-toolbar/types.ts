import type { ReactNode, RefObject } from "react";

export type ComposerControlId = string;
export type ComposerToolbarInlineContext = {
  active: boolean;
  locked: boolean;
  triggerRef(node: HTMLElement | null): void;
  activate(): "opened" | "closed" | "refused";
  beginBlocking():
    | { kind: "started"; settle(outcome: "close" | "stay"): void }
    | { kind: "refused" };
};
export type PanelSession = { controlId: ComposerControlId; session: number };
export type ComposerToolbarPanelContext = {
  host: "inline" | "overflow";
  locked: boolean;
  panel: PanelSession;
  requestDismiss(): "closed" | "refused";
  beginBlocking():
    | { kind: "started"; settle(outcome: "close" | "stay"): void }
    | { kind: "refused" };
  terminalClose(): void;
};
export type ComposerToolbarPanel = {
  ariaLabel: string;
  size: "compact" | "picker";
  initialFocusRef: RefObject<HTMLElement | null>;
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
