/**
 * WorkspaceNavBody — the phone drawer's body: the Write | Chat switch (main's mode), the
 * sources (`children`), and the account row. `NavigationDrawer` owns the Sheet and
 * closes it on select; this body never needs to know it lives in one.
 */

import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { role } from "@/components/ui/roles";
import { AccountMenu } from "@/features/account/AccountMenu";
import { cn } from "@/lib/utils";
import { MainModeSwitch } from "./MainModeSwitch";

export function WorkspaceNavBody({
  projectId,
  onSwitched,
  children,
}: {
  projectId: string;
  /** After the switch has moved main: the drawer closes onto it. */
  onSwitched: () => void;
  /** The sources, between the switch and the account row. */
  children?: ReactNode;
}) {
  return (
    <>
      <div className="shrink-0 px-3 py-3">
        <MainModeSwitch projectId={projectId} onSwitched={onSwitched} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border-subtle pt-1">
        {children}
      </div>

      <div
        className="shrink-0 border-t border-border-subtle px-2 pt-2"
        style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}
      >
        {/* The account sits before the way out, so a near miss never leaves the project. */}
        <AccountMenu />
        <Link
          to="/"
          className={cn(
            "focus-ring flex min-h-11 items-center gap-2 rounded-md px-2 no-underline hover:text-foreground",
            role.row,
            role.secondary,
            role.hover,
          )}
        >
          <ArrowLeft className="size-4 shrink-0" aria-hidden />
          <Trans>View projects</Trans>
        </Link>
      </div>
    </>
  );
}
