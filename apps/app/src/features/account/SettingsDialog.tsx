/**
 * SettingsDialog — the single settings surface for the authenticated app,
 * rendered as a routed overlay: setting `?settings=<section>` on any
 * authenticated route opens it. URL-addressable by construction — Back closes
 * it, refresh restores it, and a shared link lands on the exact section — while
 * the one component behaves identically over every authenticated route.
 *
 * Two presentations, one mounted Dialog and one routed mechanism:
 * - Desktop: centered modal with a left section rail.
 * - Phone (`usePhoneShell()`): full-screen takeover (fade only, no zoom) via
 *   `PhoneSettingsContent` — WebKit blanks transform-animated content under
 *   overflow clipping + radius.
 */
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import type { LucideIcon } from "lucide-react";
import { CircleUserRound, CreditCard, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useCallback, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SectionLabel as UiSectionLabel } from "@/components/ui/section-label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UsageCard } from "@/features/billing/UsageCard";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { useTextSize } from "@/hooks/use-text-size";
import { changeLocale, SUPPORTED_LOCALES, type SupportedLocale } from "@/lib/i18n";
import { changeTextSize, TEXT_SIZES, type TextSize } from "@/lib/text-size";
import { cn } from "@/lib/utils";
import { PhoneSettingsContent, type PhoneSettingsSectionItem } from "./PhoneSettings";

/** The overlay's section keys — the legal values of the `?settings=` param. */
export const SETTINGS_SECTIONS = ["profile", "preferences", "usage"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Open/close the settings overlay by patching `?settings=` on the CURRENT
 * route — the path never changes, which is what lets the overlay work
 * identically from any shell. Shared by the account menu, the ⌘, shortcut, and
 * the dialog's own rail/close affordances.
 */
export function useSettingsNavigation() {
  const navigate = useNavigate();
  const defaultSection: SettingsSection = "preferences";

  const setSection = useCallback(
    (section: SettingsSection | undefined, replace: boolean) => {
      void navigate({
        to: ".",
        search: (prev: Record<string, unknown>) => ({ ...prev, settings: section }),
        replace,
      });
    },
    [navigate],
  );

  const open = useCallback(
    (section?: SettingsSection) => setSection(section ?? defaultSection, false),
    [setSection],
  );
  // Section switches replace history so a single Back closes the overlay
  // instead of replaying every rail click.
  const switchSection = useCallback(
    (section: SettingsSection) => setSection(section, true),
    [setSection],
  );
  const close = useCallback(() => setSection(undefined, false), [setSection]);

  return { defaultSection, open, switchSection, close };
}

const SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
  profile: CircleUserRound,
  preferences: SlidersHorizontal,
  usage: CreditCard,
};

function SectionLabel({ section }: { section: SettingsSection }) {
  switch (section) {
    case "profile":
      return <Trans>Profile</Trans>;
    case "preferences":
      return <Trans>Preferences</Trans>;
    case "usage":
      return <Trans>Usage</Trans>;
  }
}

function phoneSections(): PhoneSettingsSectionItem[] {
  return SETTINGS_SECTIONS.map((section) => ({
    section,
    icon: SECTION_ICONS[section],
    label: <SectionLabel section={section} />,
  }));
}

/**
 * One body per section, parameterized by presentation — the phone takeover and
 * the desktop dialog render the SAME bodies; only the surrounding chrome
 * differs. This is the single place that maps a section to its content.
 */
const SECTION_CONTENT: Record<SettingsSection, (presentation: SectionPresentation) => ReactNode> = {
  profile: (presentation) => <ProfileSection presentation={presentation} />,
  preferences: (presentation) => <PreferencesSection presentation={presentation} />,
  usage: () => <UsageSection />,
};

function SectionContent({
  section,
  presentation,
}: {
  section: SettingsSection | undefined;
  presentation: SectionPresentation;
}) {
  return section ? SECTION_CONTENT[section](presentation) : null;
}

export function SettingsDialog() {
  const search = useSearch({ strict: false }) as { settings?: SettingsSection };
  const { open, switchSection, close } = useSettingsNavigation();
  // `null` until the media query resolves (first client effect) — render no
  // content for that frame rather than flashing the wrong presentation.
  const isPhone = usePhoneShell();

  const section = search.settings;

  // ⌘,/Ctrl+, — the conventional settings shortcut, app-wide.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        open();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <Dialog
      open={section !== undefined}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {isPhone === null ? null : isPhone ? (
        <PhoneSettingsContent
          section={section}
          sections={phoneSections()}
          onSwitchSection={switchSection}
        >
          <SectionContent section={section} presentation="phone" />
        </PhoneSettingsContent>
      ) : (
        <DialogContent className="flex h-[540px] max-w-3xl gap-0 overflow-hidden p-0">
          <aside className="flex w-52 shrink-0 flex-col gap-4 border-r border-border-subtle bg-muted px-3 py-4">
            <DialogTitle className="px-2 text-lg font-semibold tracking-tight">
              <Trans>Settings</Trans>
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Account settings.</Trans>
            </DialogDescription>
            <nav className="flex flex-col gap-4" aria-label={t`Settings sections`}>
              <SectionGroup label={<Trans>Account</Trans>}>
                {SETTINGS_SECTIONS.map((item) => (
                  <SectionLink
                    key={item}
                    section={item}
                    active={section}
                    onSelect={switchSection}
                  />
                ))}
              </SectionGroup>
            </nav>
          </aside>
          <section className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
            <SectionContent section={section} presentation="desktop" />
          </section>
        </DialogContent>
      )}
    </Dialog>
  );
}

function SectionGroup({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <UiSectionLabel variant="group" className="px-2">
        {label}
      </UiSectionLabel>
      {children}
    </div>
  );
}

function SectionLink({
  section,
  active,
  onSelect,
}: {
  section: SettingsSection;
  active: SettingsSection | undefined;
  onSelect: (section: SettingsSection) => void;
}) {
  const Icon = SECTION_ICONS[section];
  const isActive = section === active;
  return (
    <button
      type="button"
      onClick={() => onSelect(section)}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "focus-ring flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        isActive
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <SectionLabel section={section} />
    </button>
  );
}

function TextSizeLabel({ textSize }: { textSize: TextSize }) {
  switch (textSize) {
    case "sm":
      return <Trans>Small</Trans>;
    case "md":
      return <Trans>Medium</Trans>;
    case "lg":
      return <Trans>Large</Trans>;
  }
}

function SectionHeading({ title, description }: { title: ReactNode; description: ReactNode }) {
  return (
    <header className="mb-5">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </header>
  );
}

/**
 * Sections take a `presentation` because the phone/desktop split is a shell
 * decision (coarse pointer), not a viewport breakpoint. Phone stacks each label
 * above its control; the desktop `w-28` label + flex-1 control row leaves too
 * little input width at 393px.
 */
type SectionPresentation = "desktop" | "phone";

function ProfileSection({ presentation = "desktop" }: { presentation?: SectionPresentation }) {
  const { user } = useAuth();
  const stacked = presentation === "phone";
  const fields: Array<[label: string, value: string]> = [
    [t`First name`, user?.firstName ?? ""],
    [t`Last name`, user?.lastName ?? ""],
    [t`Email`, user?.email ?? ""],
    [t`Id`, user?.id ?? ""],
  ];

  return (
    <div>
      <SectionHeading
        title={<Trans>Profile</Trans>}
        description={<Trans>Your WorkOS profile, as seen by Meridian.</Trans>}
      />
      <div className="flex flex-col gap-4">
        {fields.map(([label, value]) => (
          <div
            key={label}
            className={cn("flex", stacked ? "flex-col gap-1.5" : "items-center gap-6")}
          >
            <span
              className={cn("text-sm font-medium text-foreground", !stacked && "w-28 shrink-0")}
            >
              {label}
            </span>
            <Input
              aria-label={label}
              value={value}
              readOnly
              className={stacked ? "w-full" : "flex-1"}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function PreferencesSection({ presentation = "desktop" }: { presentation?: SectionPresentation }) {
  const { i18n } = useLingui();
  const currentLocale = i18n.locale as SupportedLocale;
  const currentTextSize = useTextSize();
  const stacked = presentation === "phone";
  const rowClassName = cn("flex", stacked ? "flex-col gap-1.5" : "items-center gap-6");
  const labelClassName = cn("text-sm font-medium text-foreground", !stacked && "w-28 shrink-0");
  const triggerClassName = cn("focus-ring", stacked ? "w-full" : "flex-1");

  return (
    <div>
      <SectionHeading
        title={<Trans>Preferences</Trans>}
        description={<Trans>How Meridian looks and reads for you, on every device.</Trans>}
      />
      <div className="space-y-4">
        <div className={rowClassName}>
          <span className={labelClassName}>
            <Trans>Language</Trans>
          </span>
          <Select
            value={currentLocale}
            onValueChange={(value) => changeLocale(value as SupportedLocale)}
          >
            <SelectTrigger className={triggerClassName} aria-label={t`Interface language`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LOCALES.map(({ code, label }) => (
                <SelectItem key={code} value={code}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className={rowClassName}>
          <span className={labelClassName}>
            <Trans>Text size</Trans>
          </span>
          <Select
            value={currentTextSize}
            onValueChange={(value) => changeTextSize(value as TextSize)}
          >
            <SelectTrigger className={triggerClassName} aria-label={t`Reading text size`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEXT_SIZES.map((textSize) => (
                <SelectItem key={textSize} value={textSize}>
                  <TextSizeLabel textSize={textSize} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

/**
 * UsageSection — read-only usage + balance summary with a link to the
 * standalone /billing page. Intentionally minimal: subscription and extra-usage
 * purchase flows live on their own page, not inside the settings overlay.
 */
function UsageSection() {
  return (
    <div>
      <SectionHeading
        title={<Trans>Usage</Trans>}
        description={<Trans>How much of your plan you have used this month.</Trans>}
      />

      <div className="space-y-5">
        <UsageCard variant="compact" />

        <Link to="/billing" className="inline-block">
          <Button type="button" variant="outline">
            <Trans>Manage billing</Trans>
          </Button>
        </Link>
      </div>
    </div>
  );
}
