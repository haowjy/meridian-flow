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
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import type { LucideIcon } from "lucide-react";
import { CircleUserRound, CreditCard, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { updateAccountSettings } from "@/client/api/account-api";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UsageCard } from "@/features/billing/UsageCard";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { useTextSize } from "@/hooks/use-text-size";
import { useUiTheme } from "@/hooks/use-ui-theme";
import { changeLocale, SUPPORTED_LOCALES, type SupportedLocale } from "@/lib/i18n";
import { changeTextSize, TEXT_SIZES, type TextSize } from "@/lib/text-size";
import { changeUiTheme, UI_THEMES, type UiTheme } from "@/lib/ui-theme";
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
const SECTION_CONTENT: Record<
  SettingsSection,
  (presentation: SectionPresentation, workingSetSyncEnabled: boolean | null) => ReactNode
> = {
  profile: (presentation) => <ProfileSection presentation={presentation} />,
  preferences: (presentation, workingSetSyncEnabled) => (
    <PreferencesSection presentation={presentation} workingSetSyncEnabled={workingSetSyncEnabled} />
  ),
  usage: () => <UsageSection />,
};

function SectionContent({
  section,
  presentation,
  workingSetSyncEnabled,
}: {
  section: SettingsSection | undefined;
  presentation: SectionPresentation;
  workingSetSyncEnabled: boolean | null;
}) {
  return section ? SECTION_CONTENT[section](presentation, workingSetSyncEnabled) : null;
}

export function SettingsDialog({
  workingSetSyncEnabled,
}: {
  workingSetSyncEnabled: boolean | null;
}) {
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
          <SectionContent
            section={section}
            presentation="phone"
            workingSetSyncEnabled={workingSetSyncEnabled}
          />
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
            <SectionContent
              section={section}
              presentation="desktop"
              workingSetSyncEnabled={workingSetSyncEnabled}
            />
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

function UiThemeLabel({ theme }: { theme: UiTheme }) {
  switch (theme) {
    case "ink-jade":
      return <Trans>Ink & Jade</Trans>;
    case "porcelain":
      return <Trans>Porcelain</Trans>;
    case "parchment":
      return <Trans>Parchment</Trans>;
    case "graphite":
      return <Trans>Graphite</Trans>;
    case "moss":
      return <Trans>Moss & Cream</Trans>;
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

function PreferencesSection({
  presentation = "desktop",
  workingSetSyncEnabled,
}: {
  presentation?: SectionPresentation;
  workingSetSyncEnabled: boolean | null;
}) {
  const { i18n } = useLingui();
  const currentLocale = i18n.locale as SupportedLocale;
  const currentTextSize = useTextSize();
  const currentUiTheme = useUiTheme();
  const stacked = presentation === "phone";
  const rowClassName = cn("flex", stacked ? "flex-col gap-1.5" : "items-center gap-6");
  const labelClassName = cn("text-sm font-medium text-foreground", !stacked && "w-28 shrink-0");
  const triggerClassName = cn("focus-ring", stacked ? "w-full" : "flex-1");
  const router = useRouter();
  const [resumeAcrossDevices, setResumeAcrossDevices] = useState(workingSetSyncEnabled ?? false);
  const [savingResumePreference, setSavingResumePreference] = useState(false);

  useEffect(() => {
    if (workingSetSyncEnabled !== null) setResumeAcrossDevices(workingSetSyncEnabled);
  }, [workingSetSyncEnabled]);

  async function retryResumePreference() {
    setSavingResumePreference(true);
    try {
      await router.invalidate();
    } finally {
      setSavingResumePreference(false);
    }
  }

  async function changeResumePreference(enabled: boolean) {
    setResumeAcrossDevices(enabled);
    setSavingResumePreference(true);
    try {
      await updateAccountSettings({ workingSetSyncEnabled: enabled });
      // Refresh the authenticated route's cached session user so the sync
      // driver and every mounted settings presentation share the server value.
      await router.invalidate();
    } catch {
      setResumeAcrossDevices(!enabled);
    } finally {
      setSavingResumePreference(false);
    }
  }

  return (
    <div>
      <SectionHeading
        title={<Trans>Preferences</Trans>}
        description={<Trans>Appearance and behavior settings.</Trans>}
      />

      <Tabs defaultValue="device">
        <TabsList>
          <TabsTrigger value="device">
            <Trans>This device</Trans>
          </TabsTrigger>
          <TabsTrigger value="account">
            <Trans>Account</Trans>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="device">
          <div className="space-y-4">
            <div className={rowClassName}>
              <span className={labelClassName}>
                <Trans>Theme</Trans>
              </span>
              <Select
                value={currentUiTheme}
                onValueChange={(value) => changeUiTheme(value as UiTheme)}
              >
                <SelectTrigger className={triggerClassName} aria-label={t`Color theme`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UI_THEMES.map((theme) => (
                    <SelectItem key={theme} value={theme}>
                      <UiThemeLabel theme={theme} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

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
        </TabsContent>

        <TabsContent value="account">
          <div className="flex items-center justify-between gap-6">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                <Trans>Resume where I left off on any device</Trans>
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {workingSetSyncEnabled === null ? (
                  <Trans>
                    Your saved preference is unavailable. Sync is paused until retry succeeds.
                  </Trans>
                ) : (
                  <Trans>Reopens your last document and chat when you switch devices</Trans>
                )}
              </p>
            </div>
            {workingSetSyncEnabled === null ? (
              <Button
                type="button"
                variant="outline"
                disabled={savingResumePreference}
                onClick={() => void retryResumePreference()}
              >
                <Trans>Retry</Trans>
              </Button>
            ) : (
              <Switch
                checked={resumeAcrossDevices}
                disabled={savingResumePreference}
                onCheckedChange={(enabled) => void changeResumePreference(enabled)}
                aria-label={t`Resume where I left off on any device`}
              />
            )}
          </div>
        </TabsContent>
      </Tabs>
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
