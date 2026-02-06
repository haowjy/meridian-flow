import * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        // Base styles - uses "well" effect with inset shadow for depth
        "placeholder:text-muted-foreground bg-card border-editor-input-border w-full min-w-0 rounded-sm border px-3 py-2 font-sans text-base transition-all outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-[--opacity-disabled] md:text-sm",
        // Hover: subtle border enhancement
        "hover:border-primary/30",
        // Focus: primary border (green/sage highlight)
        "focus-visible:border-primary focus-visible:outline-none",
        // Error state
        "aria-invalid:border-error aria-invalid:hover:border-error aria-invalid:focus-visible:border-error",
        // Textarea-specific (allow vertical resize by default)
        "resize-y",
        className,
      )}
      style={{ boxShadow: "var(--editor-inset-shadow)" }}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
