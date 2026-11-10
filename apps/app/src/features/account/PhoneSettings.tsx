/**
 * PhoneSettings — full-screen phone chrome for the routed settings overlay.
 *
 * Settings routing and section bodies stay in `SettingsDialog`; this module owns
 * the phone's horizontal section chips and body padding inside `PhoneTakeover`.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { PhoneTakeover } from "@/components/ui/phone-shell";
import { cn } from "@/lib/utils";
import type { SettingsSection } from "./settings-sections";

export type PhoneSettingsSectionItem = {
  section: SettingsSection;
  label: ReactNode;
  icon: LucideIcon;
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
    <PhoneTakeover
      title={<Trans>Settings</Trans>}
      description={<Trans>Account settings.</Trans>}
      closeLabel={t`Close settings`}
      belowTitle={
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
      }
    >
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
    </PhoneTakeover>
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
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(item.section)}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        // scroll-mx matches the row's 0.75rem padding so scrollIntoView
        // doesn't pin the chip flush against the viewport edge.
        "focus-ring flex h-11 shrink-0 scroll-mx-3 items-center gap-2 whitespace-nowrap rounded-full border px-4 text-sm transition-colors active:scale-[0.98]",
        isActive
          ? "border-transparent bg-ink-fill-strong font-medium text-foreground"
          : "border-border-subtle text-muted-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {item.label}
    </button>
  );
}
