import { createFileRoute, redirect } from "@tanstack/react-router";
import { endOtherSignIns } from "@/core/account-sign-outs";

export const Route = createFileRoute("/logout")({
  ssr: false,
  preload: false,
  loader: () => {
    endOtherSignIns(null);
    throw redirect({ href: "/end-session", reloadDocument: true });
  },
});
