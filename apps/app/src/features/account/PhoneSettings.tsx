/**
 * PhoneSettings — full-screen phone chrome for the routed settings overlay.
 *
 * Settings routing and section bodies stay in `SettingsDialog`; this module owns
 * only the phone takeover shell, safe-area header, close icon, and horizontal
 * section chips so the desktop dialog file does not carry phone chrome.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type ReactNode, useEffect, useRef } from "react";

import {
  DialogClose,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { cn } from "@/lib/utils";
import type { SettingsSection } from "./SettingsDialog";

export type PhoneSettingsSectionItem = {
  section: SettingsSection;
  label: ReactNode;
  icon: LucideIcon;
  /** Visual divider before this chip, used between section scopes. */
  dividerBefore?: boolean;
};

export function PhoneSettingsContent({
  section,
  sections,
  onSwitchSection,
  children,
}: {
  section: SettingsSection | undefined;
  sections: PhoneSettingsSectionItem[];
  onSwitchSection: (section: SettingsSection) => void;
  children: ReactNode;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        // Radix would auto-focus the first focusable (the close X), which can
        // paint an unwanted ring on open. Focus the content element instead — it
        // must receive focus or Radix's trap never engages and Tab escapes
        // behind the overlay.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.target as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        className="fixed inset-0 z-50 flex flex-col bg-background outline-none duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
      >
        {/* Solid bg, no backdrop-filter — iOS repaint reasoning. */}
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
            {/* 44px spacer mirrors the trailing close slot to keep the title centered. */}
            <span className="size-11 shrink-0" aria-hidden />
            <DialogTitle className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-foreground">
              <Trans>Settings</Trans>
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Account settings.</Trans>
            </DialogDescription>
            <DialogClose asChild>
              <PhoneIconButton aria-label={t`Close settings`}>
                <X className="size-5" aria-hidden />
              </PhoneIconButton>
            </DialogClose>
          </div>
          <nav
            className="flex items-center gap-2 overflow-x-auto pb-2"
            aria-label={t`Settings sections`}
            style={{
              paddingLeft: "calc(0.75rem + env(safe-area-inset-left))",
              paddingRight: "calc(0.75rem + env(safe-area-inset-right))",
            }}
          >
            {sections.map((item) => (
              <SectionChip
                key={item.section}
                item={item}
                active={section}
                onSelect={onSwitchSection}
              />
            ))}
          </nav>
        </header>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-5"
          style={{
            paddingLeft: "calc(1rem + env(safe-area-inset-left))",
            paddingRight: "calc(1rem + env(safe-area-inset-right))",
            paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))",
          }}
        >
          {children}
        </div>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function SectionChip({
  item,
  active,
  onSelect,
}: {
  item: PhoneSettingsSectionItem;
  active: SettingsSection | undefined;
  onSelect: (section: SettingsSection) => void;
}) {
  const isActive = item.section === active;
  const ref = useRef<HTMLButtonElement>(null);
  const Icon = item.icon;

  // Keep the active chip visible in the scrollable row.
  useEffect(() => {
    if (isActive) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [isActive]);

  return (
    <>
      {item.dividerBefore ? <span className="h-6 w-px shrink-0 bg-border" aria-hidden /> : null}
      <button
        ref={ref}
        type="button"
        onClick={() => onSelect(item.section)}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          // scroll-mx matches the row's 0.75rem padding so scrollIntoView
          // doesn't pin the chip flush against the viewport edge.
          "focus-ring flex h-11 shrink-0 scroll-mx-3 cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border px-4 text-sm transition-colors active:scale-[0.98]",
          isActive
            ? "border-transparent bg-sidebar-accent font-medium text-foreground"
            : "border-border-subtle text-muted-foreground",
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        {item.label}
      </button>
    </>
  );
}
