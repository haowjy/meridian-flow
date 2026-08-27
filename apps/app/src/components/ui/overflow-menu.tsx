/** Visible ellipsis menu for row-contained secondary actions. */
import { Ellipsis } from "lucide-react";
import * as React from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton, type IconButtonProps } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

type DropdownRootProps = React.ComponentProps<typeof DropdownMenu>;
type DropdownContentProps = React.ComponentProps<typeof DropdownMenuContent>;
type OverflowMenuTriggerAttributes = Omit<
  IconButtonProps,
  "aria-label" | "children" | "className" | "onClick" | "onKeyDown" | "size" | "variant"
> & { [key: `data-${string}`]: string | number | boolean | undefined };

export type OverflowMenuProps = Pick<DropdownRootProps, "open" | "defaultOpen" | "onOpenChange"> & {
  children: React.ReactNode;
  label: string;
  align?: DropdownContentProps["align"];
  side?: DropdownContentProps["side"];
  alignOffset?: DropdownContentProps["alignOffset"];
  sideOffset?: DropdownContentProps["sideOffset"];
  onCloseAutoFocus?: DropdownContentProps["onCloseAutoFocus"];
  /** Layout-only visibility and hit-area adjustments; visual chrome stays canonical. */
  triggerClassName?: string;
  triggerProps?: OverflowMenuTriggerAttributes;
};

export type OverflowMenuTriggerProps = Omit<IconButtonProps, "children" | "size" | "variant">;

export const OverflowMenuTrigger = React.forwardRef<HTMLButtonElement, OverflowMenuTriggerProps>(
  ({ className, onClick, onKeyDown, ...props }, ref) => (
    <IconButton
      {...props}
      ref={ref}
      size="sm"
      className={cn(className)}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        onKeyDown?.(event);
      }}
    >
      <Ellipsis aria-hidden className="size-4" />
    </IconButton>
  ),
);
OverflowMenuTrigger.displayName = "OverflowMenuTrigger";

export function OverflowMenu({
  children,
  label,
  align = "end",
  side,
  alignOffset,
  sideOffset,
  onCloseAutoFocus,
  triggerClassName,
  triggerProps,
  open,
  defaultOpen,
  onOpenChange,
}: OverflowMenuProps) {
  return (
    <DropdownMenu open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <OverflowMenuTrigger {...triggerProps} aria-label={label} className={triggerClassName} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        side={side}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        onClick={(event) => event.stopPropagation()}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
