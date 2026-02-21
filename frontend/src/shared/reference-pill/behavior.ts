/**
 * Reference Pill Behavior
 *
 * Central contract for pill interaction capabilities.
 * All pill renderers should resolve behavior through this module so
 * CSS/data-attribute behavior stays consistent across CM6 + React surfaces.
 */

export interface PillBehavior {
  canNavigate: boolean;
  canRemove: boolean;
  hoverSwapIcon: boolean;
}

export interface PillBehaviorInput {
  canNavigate?: boolean;
  canRemove?: boolean;
  hoverSwapIcon?: boolean;
}

export interface PillBehaviorDataAttributes {
  "data-pill-navigable": "true" | "false";
  "data-pill-removable": "true" | "false";
  "data-pill-hover-swap": "true" | "false";
}

/**
 * Resolve behavior with explicit defaults and invariants.
 *
 * Invariant: hover icon swap only makes sense when remove is enabled.
 */
export function resolvePillBehavior(
  input: PillBehaviorInput = {},
): PillBehavior {
  const canNavigate = input.canNavigate ?? false;
  const canRemove = input.canRemove ?? false;
  const hoverSwapIcon = canRemove && (input.hoverSwapIcon ?? canRemove);

  return {
    canNavigate,
    canRemove,
    hoverSwapIcon,
  };
}

/**
 * Convert behavior flags to stable data attributes consumed by CSS selectors.
 */
export function pillBehaviorToDataAttributes(
  behavior: PillBehavior,
): PillBehaviorDataAttributes {
  return {
    "data-pill-navigable": behavior.canNavigate ? "true" : "false",
    "data-pill-removable": behavior.canRemove ? "true" : "false",
    "data-pill-hover-swap": behavior.hoverSwapIcon ? "true" : "false",
  };
}
