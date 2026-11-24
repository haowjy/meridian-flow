import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";
import { DisclosureMark } from "./marks";

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
        inline ? "focus-ring-outside inline-flex" : "min-h-7 coarse:min-h-11",
        className,
      )}
    >
      {multiline ? (
        <span className="flex min-w-0 flex-1 items-start gap-1">
          <DisclosureMark open={open} className="mt-[calc((1lh-0.75rem)/2)]" />
          {children}
        </span>
      ) : (
        <>
          <DisclosureMark open={open} />
          {children}
        </>
      )}
    </button>
  );
}
