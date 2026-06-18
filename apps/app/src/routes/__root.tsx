/**
 * __root route — Meridian app document shell.
 *
 * Renders the global CSS link, head/meta, i18n provider, tooltip provider,
 * AuthKit client provider, global announcement region, and router Outlet.
 */
import { I18nProvider } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthKitProvider, getAuthAction } from "@workos/authkit-tanstack-react-start/client";
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
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Noto+Serif:ital,wght@0,400;0,500;1,400&family=Inter:wght@400;500;600&display=swap",
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
  const [locale, setLocale] = useState(DEFAULT_LOCALE);

  useEffect(() => {
    const resolved = resolveLocale();
    setLocale(resolved);
    activateLocale(resolved);
  }, []);

  return (
    <RootDocument lang={locale}>
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

function RootDocument({ children, lang }: Readonly<{ children: ReactNode; lang: string }>) {
  return (
    <html lang={lang}>
      <head>
        <HeadContent />
      </head>
      <body className="paper-grain">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
