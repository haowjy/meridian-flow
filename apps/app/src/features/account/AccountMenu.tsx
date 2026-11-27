import { t } from "@lingui/core/macro";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { useState } from "react";

import { notifyFailure } from "@/components/app/failure-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useMenuActionDispatch,
} from "@/components/ui/dropdown-menu";
import { initialsFromName } from "@/features/account/initials";
import { useSettingsNavigation } from "@/features/account/SettingsDialog";
import {
  useOptionalAccountId,
  useOptionalSignOutCleanup,
} from "@/features/project/context/account-feature-context";
import {
  logoutHref,
  SIGN_OUT_FAILURE,
  SignOutIncomplete,
} from "@/features/project/context/account-feature-lifetime";

export function AccountMenu() {
  const { user, loading } = useAuth();
  const { open } = useSettingsNavigation();
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch();
  const clearBeforeSignOut = useOptionalSignOutCleanup();
  const accountId = useOptionalAccountId();
  const [leaving, setLeaving] = useState(false);

  const leave = () => {
    if (!clearBeforeSignOut || !accountId) return window.location.assign("/logout");
    setLeaving(true);
    clearBeforeSignOut().then(
      () => window.location.assign(logoutHref(accountId)),
      (error: unknown) => {
        setLeaving(false);
        if (!(error instanceof SignOutIncomplete)) reportError(error);
        notifyFailure({
          key: SIGN_OUT_FAILURE,
          title: t`Couldn't log out`,
          detail: error,
          action: { label: t`Retry`, run: leave },
        });
      },
    );
  };

  const email = user?.email ?? null;
  const label = email ?? t`Signed in`;
  const initials = initialsFromName(user?.firstName, user?.lastName, email);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        className="focus-ring grid size-8 shrink-0 place-items-center rounded-md hover:bg-ink-fill popup-open:bg-ink-fill-strong coarse:size-11"
        aria-label={t`Account: ${label}`}
        title={label}
        disabled={loading}
      >
        <span
          className="grid size-6 place-items-center rounded-full bg-ink-fill-strong text-xs font-medium text-foreground"
          aria-hidden
        >
          {initials}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={onCloseAutoFocus}>
        <DropdownMenuLabel className="truncate">{email ?? t`Signed in`}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => dispatch(() => open("profile"))}
        >{t`Profile`}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => dispatch(() => open())}>{t`Settings`}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={leaving} onSelect={() => dispatch(leave)}>
          {leaving ? t`Logging out…` : t`Log out`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
