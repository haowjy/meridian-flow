import { t } from "@lingui/core/macro";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";

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
import { useOptionalSignOutCleanup } from "@/features/project/context/account-feature-context";

export function AccountMenu() {
  const { user, loading } = useAuth();
  const { open } = useSettingsNavigation();
  const { dispatch, onCloseAutoFocus } = useMenuActionDispatch();
  const clearBeforeSignOut = useOptionalSignOutCleanup();

  const email = user?.email ?? null;
  const label = email ?? t`Signed in`;
  const initials = initialsFromName(user?.firstName, user?.lastName, email);

  return (
    <DropdownMenu>
      {/* One place for the account and Settings: the avatar, in every header that shows it. */}
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
        <DropdownMenuItem asChild>
          {/* signOut() redirects to api.workos.com; a client-side <Link> would fetch it and fail CORS. */}
          <a
            href="/logout"
            onClick={(event) => {
              if (!clearBeforeSignOut) return;
              // The account's local copies go before the browser leaves for the sign-out.
              event.preventDefault();
              void clearBeforeSignOut()
                .catch((error: unknown) => reportError(error))
                .finally(() => window.location.assign("/logout"));
            }}
          >{t`Log out`}</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
