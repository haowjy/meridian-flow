"use client";

import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "md" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "data-checked:bg-primary data-unchecked:bg-muted focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 dark:data-unchecked:bg-muted/80 peer group/switch relative inline-flex min-h-0 min-w-0 shrink-0 items-center rounded-full border border-transparent p-[2px] transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-3.5 after:content-[''] focus-visible:ring-[3px] aria-invalid:ring-[3px] data-disabled:cursor-not-allowed data-disabled:opacity-50 data-[size=default]:h-[24px] data-[size=default]:w-[44px] data-[size=md]:h-[20px] data-[size=md]:w-[36px] data-[size=sm]:h-[16px] data-[size=sm]:w-[28px]",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        data-size={size}
        className="dark:data-unchecked:bg-foreground dark:data-checked:bg-primary-foreground pointer-events-none block rounded-full bg-white ring-0 transition-transform duration-200 ease-in-out data-[size=default]:size-[20px] data-[size=default]:data-checked:translate-x-[20px] data-[size=default]:data-unchecked:translate-x-0 data-[size=md]:size-[16px] data-[size=md]:data-checked:translate-x-[16px] data-[size=md]:data-unchecked:translate-x-0 data-[size=sm]:size-[12px] data-[size=sm]:data-checked:translate-x-[12px] data-[size=sm]:data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
