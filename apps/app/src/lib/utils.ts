/**
 * utils — the `cn()` className combiner (clsx + tailwind-merge). Shared by every
 * component for conditional/merged Tailwind classes. Barrel-thin utility module.
 */
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Our design tokens add custom `--text-*` font-size roles (`text-meta`,
 * `text-body`, …). tailwind-merge doesn't know these are font sizes, so it
 * mis-classifies e.g. `text-meta` as a *color* and silently drops it when a
 * later `text-<color>` appears in the same `cn()` call — the element then
 * renders at the inherited 16px. Registering every custom size token in the
 * `font-size` class group makes `cn("text-meta text-foreground")` keep both
 * (size + color) and makes two roles collide correctly (last one wins).
 *
 * Keep this list in sync with the `--text-*` tokens in
 * `packages/design-tokens/src/ink-jade.css`.
 */
const CUSTOM_FONT_SIZE_TOKENS = [
  "meta",
  "body",
  "answer",
  "caption",
  "fine",
  "micro",
  "eyebrow",
  "headline-hero",
  "headline-section",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...CUSTOM_FONT_SIZE_TOKENS] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
