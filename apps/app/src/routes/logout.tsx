/** /logout route — clears the WorkOS session via `signOut()` in its loader. */
import { createFileRoute } from "@tanstack/react-router";
import { signOut } from "@workos/authkit-tanstack-react-start";

export const Route = createFileRoute("/logout")({
  preload: false,
  loader: async () => {
    await signOut();
  },
});
