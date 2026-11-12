import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";
import { DisclosureMark } from "./marks";

/**
 * The one control that folds and unfolds something: a list's group, a chat's steps, a receipt's
 * details. The chevron leads; there is no hover fill, hover darkens the label. It is a row's
 * height, or `inline` where it sits in a line of text and takes that line's height. A `multiline`
 * label wraps, and the chevron stays on its first line.
 */
export function FoldToggle({
  open,
  onToggle,
  inline = false,
  multiline = false,
  className,
  children,
  ref,
  ...props
}: {
  open: boolean;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
  inline?: boolean;
  multiline?: boolean;
  /** Layout and type only; the colour, chevron and focus ring are the toggle's. */
  className?: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "type" | "className">) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        "focus-ring flex min-w-0 items-center gap-1 rounded-md text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground motion-reduce:transition-none",
        // Inline, the label runs to the box edge: an inset ring would cross it.
        inline ? "focus-ring-outside inline-flex" : "min-h-7 coarse:min-h-11",
        multiline && "items-start",
        className,
      )}
    >
      <DisclosureMark open={open} className={cn(multiline && "mt-[calc((1lh-0.75rem)/2)]")} />
      {children}
    </button>
  );
}
