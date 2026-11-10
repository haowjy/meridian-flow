/**
 * The phone's two overlay shells. `PhoneTakeover` is a full-screen dialog with a
 * safe-area header: a leading slot, a centred title and a close button.
 * `PhoneSheet` is a bottom sheet with a grabber, a title and a close button. Callers
 * supply the body and its scrolling.
 */
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";

import {
  DialogClose,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

/** Content of a Radix `Dialog` the caller owns. */
export function PhoneTakeover({
  title,
  description,
  closeLabel,
  leading,
  belowTitle,
  children,
}: {
  title: ReactNode;
  /** Read by screen readers only. */
  description: ReactNode;
  closeLabel: string;
  /** A Back button, when the screen has somewhere to go back to. */
  leading?: ReactNode;
  /** A second header row, such as section navigation. */
  belowTitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        // Radix would focus the close button and paint its ring on open. The content
        // takes focus instead: without a focused element inside, the focus trap never
        // engages and Tab escapes behind the overlay.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.target as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        className="fixed inset-0 z-50 flex flex-col bg-background outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
      >
        {/* Solid background, no backdrop-filter: iOS repaints a blurred header badly. */}
        <header
          className="shrink-0 border-b border-border-subtle bg-background"
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <div
            className="flex h-12 items-center gap-1"
            style={{
              paddingLeft: "calc(0.5rem + env(safe-area-inset-left))",
              paddingRight: "calc(0.5rem + env(safe-area-inset-right))",
            }}
          >
            {/* The empty slot is as wide as the close button, so the title stays centred. */}
            {leading ?? <span className="size-11 shrink-0" aria-hidden />}
            <DialogTitle className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-foreground">
              {title}
            </DialogTitle>
            <DialogDescription className="sr-only">{description}</DialogDescription>
            <DialogClose asChild>
              <IconButton size="sm" label={closeLabel}>
                <X className="size-5" aria-hidden />
              </IconButton>
            </DialogClose>
          </div>
          {belowTitle}
        </header>
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function PhoneSheet({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  children,
  ...content
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Read by screen readers only. */
  description: ReactNode;
  closeLabel: string;
  children: ReactNode;
} & Omit<ComponentProps<typeof SheetContent>, "title" | "side" | "className" | "style">) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="max-h-[78svh] gap-0 rounded-t-xl border-border-subtle p-0 outline-none"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        // The sheet takes focus, not its close button: see PhoneTakeover.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.target as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        {...content}
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border" />
        <div className="flex shrink-0 items-center gap-2 pl-4 pr-1">
          <SheetTitle className="min-w-0 flex-1 truncate text-sm">{title}</SheetTitle>
          <IconButton size="sm" label={closeLabel} onClick={() => onOpenChange(false)}>
            <X className="size-5" aria-hidden />
          </IconButton>
        </div>
        <SheetDescription className="sr-only">{description}</SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  );
}
