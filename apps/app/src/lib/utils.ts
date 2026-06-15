/**
 * utils — the `cn()` className combiner (clsx + tailwind-merge). Shared by every
 * component for conditional/merged Tailwind classes. Barrel-thin utility module.
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
