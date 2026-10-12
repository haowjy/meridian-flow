/**
 * __root route — Meridian app document shell.
 *
 * Renders the global CSS link, the link chip's icon rules, head/meta, i18n
 * provider, tooltip provider, AuthKit client provider, global announcement
 * region, and router Outlet.
 */
import { I18nProvider } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { createRootRoute, HeadContent, Outlet, Scripts, useMatches } from "@tanstack/react-router";
import { AuthKitProvider, getAuthAction } from "@workos/authkit-tanstack-react-start/client";
import type { ReactNode } from "react";
import { useEffect, useSyncExternalStore } from "react";

import { AnnouncementRegion } from "@/components/app/AnnouncementRegion";
import { LINK_CHIP_ICON_CSS } from "@/components/app/link-chip/family-icons";
import { TooltipProvider } from "@/components/ui/tooltip";
import { activateLocale, DEFAULT_LOCALE, i18n, resolveLocale } from "@/lib/i18n";
import { IOS_FOCUS_ZOOM_BOOT_SCRIPT } from "@/lib/ios-focus-zoom";
import { TEXT_SIZE_BOOT_SCRIPT } from "@/lib/text-size";
import { createUiThemeBootScript } from "@/lib/ui-theme";
import { PERSISTENT_SHELL_OPTIONS } from "@/router-shell";
import globalCssUrl from "@/styles/globals.css?url";

export const Route = createRootRoute({
  ...PERSISTENT_SHELL_OPTIONS,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
      },
      { title: "Meridian" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600;1,700&display=swap",
      },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: globalCssUrl },
    ],
  }),
  loader: async () => {
    const auth = await getAuthAction();
    return { auth };
  },
  component: RootComponent,
  notFoundComponent: () => (
    <main className="grid min-h-svh place-items-center bg-background text-foreground">
      <Trans>Not Found</Trans>
    </main>
  ),
});

function RootComponent() {
  const { auth } = Route.useLoaderData();
  const matches = useMatches();
  const account = matches.find((match) => match.routeId === "/_authenticated")?.loaderData as
    | {
        user?: {
          userId: string;
          accountSettings?: { theme: import("@/lib/ui-theme").UiTheme } | null;
        };
      }
    | undefined;
  const user = account?.user;
  const themeBootScript = createUiThemeBootScript(
    user ? { accountId: user.userId, theme: user.accountSettings?.theme } : undefined,
  );
  const locale = useSyncExternalStore(
    (onChange) => i18n.on("change", onChange),
    () => i18n.locale || DEFAULT_LOCALE,
    () => DEFAULT_LOCALE,
  );

  useEffect(() => {
    const resolved = resolveLocale();
    activateLocale(resolved);
  }, []);

  return (
    <RootDocument lang={locale} themeBootScript={themeBootScript}>
      <I18nProvider i18n={i18n}>
        <AuthKitProvider initialAuth={auth}>
          <TooltipProvider>
            <AnnouncementRegion />
            <Outlet />
          </TooltipProvider>
        </AuthKitProvider>
      </I18nProvider>
    </RootDocument>
  );
}

function RootDocument({
  children,
  lang,
  themeBootScript,
}: Readonly<{ children: ReactNode; lang: string; themeBootScript: string }>) {
  return (
    <html lang={lang} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: TEXT_SIZE_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <HeadContent />
        {/* Generated from the family icon data, so the link chip's images and
            the scheme icons share one source. */}
        <style dangerouslySetInnerHTML={{ __html: LINK_CHIP_ICON_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: IOS_FOCUS_ZOOM_BOOT_SCRIPT }} />
      </head>
      <body className="paper-grain">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
