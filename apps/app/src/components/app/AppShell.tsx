// @ts-nocheck
/**
 * AppShell — authenticated app frame with project navigation, account chrome,
 * and the viewport-locked main pane. Feature routes provide the main content;
 * this shell owns the desktop-only persistent sidebar scaffold.
 */
import type { ReactNode } from "react";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

import { AppSidebar } from "./AppSidebar";
import { ConnectionBanner } from "./ConnectionBanner";

/**
 * Authenticated desktop shell: persistent `AppSidebar` + main inset.
 *
 * Bare-view routes (`/project/*`, `/chat/*`) skip this shell entirely — see
 * `_authenticated.tsx`.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider
      className="main-pane app-frame"
      style={
        {
          "--sidebar-width": "17.5rem",
        } as React.CSSProperties
      }
    >
      <AppSidebar />
      <SidebarInset className="main-pane flex min-h-0 flex-col">
        <ConnectionBanner />
        <div className="app-scroll">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
