/**
 * /api/auth/callback route — WorkOS AuthKit OAuth callback handler. Delegates to
 * `handleCallbackRoute()` to complete sign-in and mint the session cookie. App-
 * owned (must run in the TanStack Start session process).
 */
import { createFileRoute } from "@tanstack/react-router";
import { handleCallbackRoute } from "@workos/authkit-tanstack-react-start";

export const Route = createFileRoute("/api/auth/callback")({
  server: {
    handlers: {
      GET: handleCallbackRoute(),
    },
  },
});
