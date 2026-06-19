/**
 * THROWAWAY palette presets for the /proto/palette exploration.
 *
 * The eight ground/chrome tokens we let the prototype override. Identity
 * (jade primary, cinnabar accent, ink text, fonts) stays fixed — see
 * `design-direction-ink-jade.md`. Each preset matches a parallel mockup
 * direction; copy the winning set into `packages/design-tokens/src/ink-jade.css`.
 */

export const PALETTE_TOKENS = [
  "--color-background",
  "--color-card",
  "--color-popover",
  "--color-sidebar",
  "--color-sidebar-accent",
  "--color-surface-warm",
  "--color-border",
  "--color-border-subtle",
] as const;

export type PaletteToken = (typeof PALETTE_TOKENS)[number];

export type PaletteValues = Record<PaletteToken, string>;

export type PalettePreset = {
  id: "recessed-chrome" | "unified-paper" | "floating-canvas";
  letter: "A" | "B" | "C";
  label: string;
  description: string;
  values: PaletteValues;
  manuscriptElevated: boolean;
};

export const PALETTE_PRESETS: PalettePreset[] = [
  {
    id: "recessed-chrome",
    letter: "A",
    label: "Recessed Chrome",
    description: "Deep frame, bright page. Sidebar/dock darken to push the manuscript forward.",
    values: {
      "--color-background": "oklch(0.975 0.010 90)",
      "--color-card": "oklch(0.985 0.008 90)",
      "--color-popover": "oklch(0.985 0.008 90)",
      "--color-sidebar": "oklch(0.912 0.016 92)",
      "--color-sidebar-accent": "oklch(0.885 0.018 91)",
      "--color-surface-warm": "oklch(0.945 0.012 90)",
      "--color-border": "oklch(0.875 0.016 95)",
      "--color-border-subtle": "oklch(0.9 0.013 95)",
    },
    manuscriptElevated: false,
  },
  {
    id: "unified-paper",
    letter: "B",
    label: "Unified Paper",
    description: "One sheet. Sidebar, page, and dock share a value; hairline borders separate.",
    values: {
      "--color-background": "oklch(0.958 0.010 91)",
      "--color-card": "oklch(0.965 0.009 90)",
      "--color-popover": "oklch(0.965 0.009 90)",
      "--color-sidebar": "oklch(0.949 0.012 92)",
      "--color-sidebar-accent": "oklch(0.93 0.013 91)",
      "--color-surface-warm": "oklch(0.945 0.011 91)",
      "--color-border": "oklch(0.88 0.014 96)",
      "--color-border-subtle": "oklch(0.9 0.012 95)",
    },
    manuscriptElevated: false,
  },
  {
    id: "floating-canvas",
    letter: "C",
    label: "Floating Canvas",
    description: "Light chrome, framed page. Manuscript is a raised sheet over a warm dock.",
    values: {
      "--color-background": "oklch(0.958 0.010 91)",
      "--color-card": "oklch(0.986 0.006 90)",
      "--color-popover": "oklch(0.986 0.006 90)",
      "--color-sidebar": "oklch(0.965 0.009 91)",
      "--color-sidebar-accent": "oklch(0.945 0.011 91)",
      "--color-surface-warm": "oklch(0.96 0.010 91)",
      "--color-border": "oklch(0.9 0.012 95)",
      "--color-border-subtle": "oklch(0.91 0.011 95)",
    },
    manuscriptElevated: true,
  },
];

/**
 * Human labels for the readout — keep short so they fit the panel grid.
 */
export const TOKEN_LABELS: Record<PaletteToken, string> = {
  "--color-background": "background",
  "--color-card": "card",
  "--color-popover": "popover",
  "--color-sidebar": "sidebar",
  "--color-sidebar-accent": "sidebar-accent",
  "--color-surface-warm": "surface-warm",
  "--color-border": "border",
  "--color-border-subtle": "border-subtle",
};
