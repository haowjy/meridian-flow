import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// keep: tailwind-merge needs every custom text/shadow/tracking token listed or cn() drops the size
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["compact", "body"],
      shadow: ["raise", "float", "modal"],
      tracking: ["caps"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
