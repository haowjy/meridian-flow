import { createFileRoute, redirect } from "@tanstack/react-router";
import { getAuth, getSignUpUrl } from "@workos/authkit-tanstack-react-start";

export const Route = createFileRoute("/signup")({
  preload: false,
  loader: async () => {
    const { user } = await getAuth();
    if (user) throw redirect({ to: "/" });
    throw redirect({ href: await getSignUpUrl({ data: { returnPathname: "/" } }) });
  },
});
