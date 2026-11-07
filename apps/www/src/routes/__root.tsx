/// <reference types="vite/client" />

import heroFont from "@fontsource/im-fell-french-canon/files/im-fell-french-canon-latin-400-normal.woff2?url";
import { MARKETING_THEME_COLOR } from "@meridian/design-tokens/marketing-sky";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import type * as React from "react";
import { DefaultCatchBoundary } from "~/components/DefaultCatchBoundary";
import { NotFound } from "~/components/NotFound";
import appCss from "~/styles/app.css?url";
import { seo } from "~/utils/seo";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: MARKETING_THEME_COLOR },
      ...seo({
        title: "Meridian Flow: AI writing app for serial storytellers",
        description:
          "Build a world. Bring it to life with a team of agents. AI writing app for serial storytellers.",
        image: "https://www.meridian-flow.com/og.jpg",
      }),
    ],
    links: [
      { rel: "preload", as: "font", type: "font/woff2", href: heroFont, crossOrigin: "" },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "apple-touch-icon", href: "/icon-192.png" },
      { rel: "manifest", href: "/site.webmanifest" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: () => <NotFound />,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-right" /> : null}
        <Scripts />
      </body>
    </html>
  );
}
