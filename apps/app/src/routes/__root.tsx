// @ts-nocheck
/**
 * __root route — Meridian app document shell.
 *
 * Renders the global CSS link, head/meta, i18n provider, tooltip provider,
 * global announcement region, and router Outlet. Auth remains Supabase-backed in
 * route loaders/server helpers; no provider-specific auth shell is required here.
 */
import { I18nProvider } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { AnnouncementRegion } from "@/components/app/AnnouncementRegion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { activateLocale, DEFAULT_LOCALE, i18n, resolveLocale } from "@/lib/i18n";
import globalCssUrl from "@/styles/globals.css?url";

export const Route = createRootRoute({
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
    links: [{ rel: "stylesheet", href: globalCssUrl }],
  }),
  component: RootComponent,
  notFoundComponent: () => (
    <main className="grid min-h-svh place-items-center bg-background text-foreground">
      <Trans>Not Found</Trans>
    </main>
  ),
});

function RootComponent() {
  const [locale, setLocale] = useState(DEFAULT_LOCALE);

  useEffect(() => {
    const resolved = resolveLocale();
    setLocale(resolved);
    activateLocale(resolved);
  }, []);

  return (
    <RootDocument lang={locale}>
      <I18nProvider i18n={i18n}>
        <TooltipProvider>
          <AnnouncementRegion />
          <Outlet />
        </TooltipProvider>
      </I18nProvider>
    </RootDocument>
  );
}

function RootDocument({ children, lang }: Readonly<{ children: ReactNode; lang: string }>) {
  return (
    <html lang={lang}>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
