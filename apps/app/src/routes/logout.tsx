import { createFileRoute, redirect } from "@tanstack/react-router";
import { countEverySignOut, countSignOut } from "@/core/account-sign-outs";

export const Route = createFileRoute("/logout")({
  ssr: false,
  preload: false,
  loader: ({ location }) => {
    const account = new URLSearchParams(location.searchStr).get("account");
    if (account) countSignOut(account);
    else countEverySignOut();
    const query = account ? `?${new URLSearchParams({ account })}` : "";
    throw redirect({ href: `/end-session${query}`, reloadDocument: true });
  },
});
