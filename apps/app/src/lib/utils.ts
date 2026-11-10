/**
 * utils — the `cn()` className combiner (clsx + tailwind-merge). Shared by every
 * component for conditional/merged Tailwind classes. Barrel-thin utility module.
 */
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's default theme. A custom `--text-*` size it
 * doesn't know reads as a colour, so `cn("text-meta text-foreground")` would drop
 * the size; a custom shadow reads as a shadow colour. Every custom size, shadow
 * and tracking token in `packages/design-tokens/src/ink-jade.css` is listed here.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["meta", "caption", "compact", "menu", "body"],
      shadow: ["raise", "float", "modal"],
      tracking: ["caps"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
