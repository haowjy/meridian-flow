import type { ReactNode, RefObject } from "react";

export type ComposerControlId = string;
export type PanelSession = { controlId: ComposerControlId; session: number };

export type ComposerToolbarTriggerBinding = {
  ref(node: HTMLButtonElement | null): void;
  buttonProps: {
    "aria-haspopup": "dialog";
    "aria-controls"?: string;
    "aria-expanded": boolean;
    "aria-busy"?: true;
    "aria-disabled"?: true;
    onClick(): void;
  };
};

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

export type ComposerToolbarFocusCandidate = {
  key: string;
  ref: RefObject<HTMLElement | null>;
};

export type ComposerToolbarPanelFocus = {
  pageId: string;
  repairRevision: string;
  candidates: readonly ComposerToolbarFocusCandidate[];
  fallback: "content";
};

export type ComposerToolbarPanel = {
  ariaLabel: string;
  size: "compact" | "identity" | "catalog";
  focus: ComposerToolbarPanelFocus;
  render(context: ComposerToolbarPanelContext): ReactNode;
};

export type ComposerToolbarItem = {
  ariaLabel: string;
  label: ReactNode;
  value?: ReactNode;
  icon?: ReactNode;
};

type ComposerToolbarControlBase = {
  id: ComposerControlId;
  priority: number;
  item: ComposerToolbarItem;
};

export type ComposerToolbarControl =
  | (ComposerToolbarControlBase & {
      kind: "status";
      inline(context: { controlRef(node: HTMLElement | null): void }): ReactNode;
    })
  | (ComposerToolbarControlBase & {
      kind: "panel";
      interaction: "enabled" | "busy";
      inline(context: { trigger: ComposerToolbarTriggerBinding }): ReactNode;
      panel: ComposerToolbarPanel;
    });

export type ComposerToolbarControlInput =
  | { id: ComposerControlId; kind: "status" }
  | {
      id: ComposerControlId;
      kind: "panel";
      interaction: "enabled" | "busy";
      page: {
        id: string;
        repairRevision: string;
        candidateKeys: readonly string[];
      };
    };

export type ToolbarNavigationInput = {
  revision: string;
  controls: readonly ComposerToolbarControlInput[];
};

export type ComposerToolbarModel = {
  controls: readonly ComposerToolbarControl[];
  input: ToolbarNavigationInput;
};

export function createToolbarNavigationInput(
  controls: readonly ComposerToolbarControl[],
): ToolbarNavigationInput {
  const ids = new Set<string>();
  const inputControls = controls.map((control): ComposerToolbarControlInput => {
    if (ids.has(control.id)) throw new Error(`Duplicate composer control ID: ${control.id}`);
    ids.add(control.id);
    if (control.kind === "status") return { id: control.id, kind: "status" };
    const candidateKeys = control.panel.focus.candidates.map(({ key }) => key);
    if (new Set(candidateKeys).size !== candidateKeys.length)
      throw new Error(`Duplicate focus candidate key for composer control: ${control.id}`);
    return {
      id: control.id,
      kind: "panel",
      interaction: control.interaction,
      page: {
        id: control.panel.focus.pageId,
        repairRevision: control.panel.focus.repairRevision,
        candidateKeys,
      },
    };
  });
  return { revision: JSON.stringify(inputControls), controls: inputControls };
}

export function createComposerToolbarModel(
  controls: readonly ComposerToolbarControl[],
): ComposerToolbarModel {
  return { controls, input: createToolbarNavigationInput(controls) };
}
