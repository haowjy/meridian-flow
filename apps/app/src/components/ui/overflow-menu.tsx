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
  "label" | "children" | "className" | "onClick" | "onKeyDown" | "size" | "variant"
> & { [key: `data-${string}`]: string | number | boolean | undefined };

export type OverflowMenuProps = Pick<DropdownRootProps, "open" | "onOpenChange"> & {
  children: React.ReactNode;
  label: string;
  /** In a row that must not grow for it: the small button, with its touch area past its box. */
  dense?: boolean;
  align?: DropdownContentProps["align"];
  sideOffset?: DropdownContentProps["sideOffset"];
  onCloseAutoFocus?: DropdownContentProps["onCloseAutoFocus"];
  /** Layout-only visibility and hit-area adjustments; visual chrome stays canonical. */
  triggerClassName?: string;
  triggerProps?: OverflowMenuTriggerAttributes;
};

export type OverflowMenuTriggerProps = Omit<IconButtonProps, "children" | "size" | "variant">;

export const OverflowMenuTrigger = React.forwardRef<HTMLButtonElement, OverflowMenuTriggerProps>(
  ({ className, onClick, onKeyDown, dense, ...props }, ref) => (
    <IconButton
      {...props}
      ref={ref}
      size={dense ? "xs" : "sm"}
      dense={dense}
      className={cn(className)}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
      onKeyDown={(event) => {
        // Left and Right still reach the list's keys (`handleListKeys`), back to the row.
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") event.stopPropagation();
        onKeyDown?.(event);
      }}
    >
      <Ellipsis aria-hidden />
    </IconButton>
  ),
);
OverflowMenuTrigger.displayName = "OverflowMenuTrigger";

export function OverflowMenu({
  children,
  label,
  dense,
  align = "end",
  sideOffset,
  onCloseAutoFocus,
  triggerClassName,
  triggerProps,
  open,
  onOpenChange,
}: OverflowMenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <OverflowMenuTrigger
          {...triggerProps}
          label={label}
          dense={dense}
          className={triggerClassName}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        sideOffset={sideOffset}
        onClick={(event) => event.stopPropagation()}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
