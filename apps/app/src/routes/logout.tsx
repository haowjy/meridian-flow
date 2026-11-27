import { createFileRoute, redirect } from "@tanstack/react-router";
import { countEverySignOut } from "@/core/account-sign-outs";

export const Route = createFileRoute("/logout")({
  ssr: false,
  preload: false,
  loader: ({ location }) => {
    const account = new URLSearchParams(location.searchStr).get("account");
    // A named account's sign-out was counted by whoever sent it here; a typed `/logout` names none.
    if (!account) countEverySignOut();
    const query = account ? `?${new URLSearchParams({ account })}` : "";
    throw redirect({ href: `/end-session${query}`, reloadDocument: true });
  },
});
